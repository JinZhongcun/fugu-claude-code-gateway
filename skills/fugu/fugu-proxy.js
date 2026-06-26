// fugu-proxy.js — let Claude Code drive Sakana Fugu.
//
// WHY: Claude Code only speaks the Anthropic Messages API (POST /v1/messages).
// Sakana exposes OpenAI-compatible faces only (/v1/chat/completions, /v1/responses);
// it has NO /v1/messages (returns 404). This proxy bridges the gap: it accepts
// Anthropic Messages requests from Claude Code, translates to Sakana's Chat
// Completions, and translates the reply (and synthetic SSE stream / tool calls) back.
//
// Auth: uses $SAKANA_API_KEY to call Sakana. The token Claude Code sends to THIS
// proxy is ignored. No OpenRouter involved — billed to your Sakana subscription.
//
// Failure policy: this gateway NEVER changes models silently. If the upstream
// fails or times out, the request fails visibly (FUGU_ON_FAILURE=fail|advise).
//
// Run:  SAKANA_API_KEY=... PORT=4000 node fugu-proxy.js
// Deps: none (Node 18+, global fetch + AbortController).
const http = require('http');
const fs   = require('fs');
const path = require('path');

const VERSION = '0.2.0';
const NAME    = 'fugu-claude-code-gateway';

const SAKANA_KEY    = process.env.SAKANA_API_KEY;
const UPSTREAM      = process.env.FUGU_UPSTREAM || 'https://api.sakana.ai/v1/chat/completions';
const DEFAULT_MODEL = process.env.FUGU_MODEL || 'fugu';     // used when request model is not a fugu variant
const EFFORT        = process.env.FUGU_EFFORT || '';         // optional: high|xhigh|max (verified accepted by Sakana chat/completions)
const PORT          = parseInt(process.env.PORT || '4000', 10);
const BIND          = process.env.FUGU_BIND || '127.0.0.1'; // loopback only by default — do NOT expose to the network
const LOG           = process.env.PROXY_LOG || path.join(__dirname, 'proxy.log');
const PIDFILE       = path.join(__dirname, 'proxy.pid');

// timeouts (ms): Fugu Ultra orchestrates a deeper pool and is slower, so it gets more headroom.
const TIMEOUT_MS       = parseInt(process.env.FUGU_TIMEOUT_MS || '300000', 10);        // 5 min
const ULTRA_TIMEOUT_MS = parseInt(process.env.FUGU_ULTRA_TIMEOUT_MS || '900000', 10);  // 15 min
// failure policy: 'fail' (default, visible error) | 'advise' (visible error + retry hint). NEVER silent fallback.
const ON_FAILURE = (process.env.FUGU_ON_FAILURE || 'fail').toLowerCase();

let reqSeq = 0;
function nowISO(){ try { return new Date().toISOString(); } catch(e){ return ''; } }
// structured JSON-lines log. NEVER logs message content / prompts / tool_result bodies.
function log(obj){
  try { fs.appendFileSync(LOG, JSON.stringify(Object.assign({ ts: nowISO() }, obj)) + '\n'); } catch(e){}
}
function readBody(req){ return new Promise((res,rej)=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>res(d)); req.on('error',rej); }); }
// parse without leaking request content into errors/logs on malformed input
function safeParse(s){ try{ return JSON.parse(s||'{}'); }catch(e){ return undefined; } }

// Route by the model name Claude Code sends (e.g. --model fugu-ultra), else default.
function pickModel(reqModel){
  if(reqModel && /ultra/i.test(reqModel)) return 'fugu-ultra';
  if(reqModel && /fugu/i.test(reqModel))  return 'fugu';
  return DEFAULT_MODEL;
}
function timeoutFor(model){ return /ultra/i.test(model) ? ULTRA_TIMEOUT_MS : TIMEOUT_MS; }

// ---- translation (Anthropic <-> OpenAI Chat Completions) — unchanged, verified working ----
function anthToOpenAI(body){
  const msgs=[];
  if(body.system){
    const sys = Array.isArray(body.system) ? body.system.map(b=>b.text||'').join('\n') : body.system;
    if(sys) msgs.push({role:'system', content:sys});
  }
  for(const m of (body.messages||[])){
    if(typeof m.content === 'string'){ msgs.push({role:m.role, content:m.content}); continue; }
    const textParts=[], toolCalls=[], toolResults=[];
    for(const blk of (m.content||[])){
      if(blk.type==='text') textParts.push(blk.text);
      else if(blk.type==='tool_use') toolCalls.push({id:blk.id, type:'function', function:{name:blk.name, arguments:JSON.stringify(blk.input||{})}});
      else if(blk.type==='tool_result') toolResults.push(blk);
    }
    if(m.role==='assistant'){
      const om={role:'assistant', content:textParts.join('\n')||null};
      if(toolCalls.length) om.tool_calls=toolCalls;
      msgs.push(om);
    } else {
      for(const tr of toolResults){
        let c=tr.content;
        if(Array.isArray(c)) c=c.map(x=>x.text||JSON.stringify(x)).join('\n');
        msgs.push({role:'tool', tool_call_id:tr.tool_use_id, content: typeof c==='string'?c:JSON.stringify(c)});
      }
      if(textParts.length) msgs.push({role:'user', content:textParts.join('\n')});
    }
  }
  const out={model:pickModel(body.model), messages:msgs};
  if(body.max_tokens) out.max_tokens=body.max_tokens;
  if(body.temperature!=null) out.temperature=body.temperature;
  if(body.top_p!=null) out.top_p=body.top_p;
  if(EFFORT) out.reasoning_effort=EFFORT;
  if(body.tools && body.tools.length){
    out.tools=body.tools.map(t=>({type:'function', function:{name:t.name, description:t.description||'', parameters:t.input_schema||{type:'object'}}}));
  }
  if(body.tool_choice){
    const tc=body.tool_choice;
    if(tc.type==='auto') out.tool_choice='auto';
    else if(tc.type==='any') out.tool_choice='required';
    else if(tc.type==='tool'&&tc.name) out.tool_choice={type:'function', function:{name:tc.name}};
  }
  return out;
}

function openAIToAnth(resp, model){
  const choice=(resp.choices&&resp.choices[0])||{};
  const msg=choice.message||{};
  const content=[];
  if(msg.content) content.push({type:'text', text:msg.content});
  if(msg.tool_calls){
    for(const tc of msg.tool_calls){
      let input={}; try{ input=JSON.parse(tc.function.arguments||'{}'); }catch(e){ input={}; }
      content.push({type:'tool_use', id:tc.id, name:tc.function.name, input});
    }
  }
  let stop='end_turn';
  if(choice.finish_reason==='length') stop='max_tokens';
  else if(choice.finish_reason==='tool_calls') stop='tool_use';
  return {
    id: resp.id||'msg_proxy', type:'message', role:'assistant', model: model||resp.model,
    content: content.length?content:[{type:'text', text:''}],
    stop_reason: stop, stop_sequence:null,
    usage:{ input_tokens:(resp.usage&&resp.usage.prompt_tokens)||0, output_tokens:(resp.usage&&resp.usage.completion_tokens)||0 }
  };
}

function sse(res,event,data){ res.write('event: '+event+'\n'); res.write('data: '+JSON.stringify(data)+'\n\n'); }
function streamAnth(res,a){
  res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
  sse(res,'message_start',{type:'message_start', message:{id:a.id,type:'message',role:'assistant',model:a.model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:a.usage.input_tokens,output_tokens:0}}});
  let idx=0;
  for(const blk of a.content){
    if(blk.type==='text'){
      sse(res,'content_block_start',{type:'content_block_start',index:idx,content_block:{type:'text',text:''}});
      sse(res,'content_block_delta',{type:'content_block_delta',index:idx,delta:{type:'text_delta',text:blk.text}});
      sse(res,'content_block_stop',{type:'content_block_stop',index:idx});
    } else if(blk.type==='tool_use'){
      sse(res,'content_block_start',{type:'content_block_start',index:idx,content_block:{type:'tool_use',id:blk.id,name:blk.name,input:{}}});
      sse(res,'content_block_delta',{type:'content_block_delta',index:idx,delta:{type:'input_json_delta',partial_json:JSON.stringify(blk.input||{})}});
      sse(res,'content_block_stop',{type:'content_block_stop',index:idx});
    }
    idx++;
  }
  sse(res,'message_delta',{type:'message_delta',delta:{stop_reason:a.stop_reason,stop_sequence:null},usage:{output_tokens:a.usage.output_tokens}});
  sse(res,'message_stop',{type:'message_stop'});
  res.end();
}

// ---- upstream call with timeout; returns a classified result ----
// kind: 'ok' | 'timeout' | 'network' | 'client' | 'server' | 'rate_limit'
async function callUpstream(oaReq, timeoutMs){
  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(UPSTREAM, { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+SAKANA_KEY}, body:JSON.stringify(oaReq), signal:ctrl.signal });
    const text = await r.text();
    if(r.ok){ let j; try{ j=JSON.parse(text); }catch(e){ j={}; } return { kind:'ok', status:r.status, json:j }; }
    let kind='client';
    if(r.status===429) kind='rate_limit';
    else if(r.status>=500) kind='server';
    return { kind, status:r.status, detail:'upstream '+r.status+': '+text.slice(0,200) };
  } catch(e){
    const isTimeout = (e && e.name==='AbortError');
    return { kind: isTimeout?'timeout':'network', detail: isTimeout ? ('timeout after '+timeoutMs+'ms') : ('network: '+(e&&e.message||e)) };
  } finally { clearTimeout(timer); }
}

function failMessage(model, r){
  let msg = (r.kind==='timeout' ? ('upstream timeout for '+model) : (r.kind+' from upstream for '+model)) + '; no fallback was performed';
  if(ON_FAILURE==='advise'){
    msg += '. You can retry; or run `FUGU_MODEL=fugu claude-fugu` to use the lighter model. '
         + 'This gateway never switches models silently.';
  }
  return msg;
}
function sendErr(res, status, message){
  res.writeHead(status,{'Content-Type':'application/json'});
  res.end(JSON.stringify({type:'error',error:{type:'api_error',message}}));
}

const server=http.createServer(async (req,res)=>{
  try{
    // --- identity / liveness (no upstream call, no billing) ---
    if(req.method==='GET' && (req.url==='/health' || req.url.startsWith('/health?'))){
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:true, name:NAME, version:VERSION, bind:BIND, port:PORT, upstream:UPSTREAM, default_model:DEFAULT_MODEL, effort:EFFORT||null, has_sakana_key:!!SAKANA_KEY, on_failure:ON_FAILURE }));
      return;
    }
    if(req.method==='GET' && req.url.startsWith('/version')){
      res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify({ name:NAME, version:VERSION })); return;
    }
    // --- explicit upstream ping (DOES call Sakana = small billing). Used by fugu-doctor. ---
    if(req.method==='POST' && req.url.startsWith('/health/upstream')){
      let model = DEFAULT_MODEL;
      try{ const b=JSON.parse((await readBody(req))||'{}'); if(b.model) model=pickModel(b.model); }catch(e){}
      const t0=Date.now();
      const r=await callUpstream({model, max_tokens:16, messages:[{role:'user',content:'ping'}]}, 30000);  // Sakana min max_tokens = 16
      res.writeHead(r.kind==='ok'?200:502,{'Content-Type':'application/json'});
      res.end(JSON.stringify({ ok:r.kind==='ok', name:NAME, model, latency_ms:Date.now()-t0, kind:r.kind, status:r.status||null, detail:r.detail||null }));
      return;
    }
    if(req.method==='POST' && req.url.startsWith('/v1/messages/count_tokens')){
      const body=safeParse(await readBody(req)); if(body===undefined){ sendErr(res,400,'invalid JSON body'); return; }
      const txt=JSON.stringify(body.messages||'')+JSON.stringify(body.system||'');
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({input_tokens:Math.ceil(txt.length/4)})); return;
    }
    if(req.method==='POST' && req.url.startsWith('/v1/messages')){
      if(!SAKANA_KEY){ sendErr(res,500,'SAKANA_API_KEY is not set in the proxy environment'); return; }
      const id='req_'+(++reqSeq);
      const body=safeParse(await readBody(req)); if(body===undefined){ sendErr(res,400,'invalid JSON body'); return; }
      const wantStream=!!body.stream;
      const model=pickModel(body.model);
      const oaReq=anthToOpenAI(body);
      log({ id, event:'in', model_in:body.model||null, model_out:model, stream:wantStream, msgs:(body.messages||[]).length, tools:(body.tools||[]).length });
      const r=await callUpstream(oaReq, timeoutFor(model));
      if(r.kind!=='ok'){
        const status=r.status || (r.kind==='timeout'?504:502);
        log({ id, event:'upstream_error', model_out:model, kind:r.kind, status });   // detail not echoed to client
        sendErr(res, status, failMessage(model, r));
        return;
      }
      const anth=openAIToAnth(r.json, model);
      log({ id, event:'out', model_out:model, blocks:anth.content.length, usage:anth.usage });
      if(wantStream) streamAnth(res,anth);
      else { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(anth)); }
      return;
    }
    res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'not found',path:req.url}));
  }catch(e){
    log({ event:'exception', error:(e&&e.name||'Error') });   // name only — never echo request/upstream content
    try{ sendErr(res,500,'proxy error'); }catch(_){}            // res may already be sent (streaming) — ignore
  }
});

// a throw after headers are sent (rare streaming path) must not crash a long-running proxy
process.on('uncaughtException', (e)=>{ log({ event:'uncaughtException', error:(e&&e.name||'Error') }); });
server.on('error', (e)=>{ log({ event:'server_error', error:(e&&e.message||String(e)) }); });

server.listen(PORT,BIND,()=>{
  try{ fs.writeFileSync(PIDFILE,String(process.pid)); }catch(e){}
  log({ event:'listening', bind:BIND, port:PORT, upstream:UPSTREAM, default_model:DEFAULT_MODEL, effort:EFFORT||null, on_failure:ON_FAILURE, version:VERSION });
  console.log('[fugu-proxy] v'+VERSION+' '+BIND+':'+PORT+' -> Sakana ('+DEFAULT_MODEL+') on_failure='+ON_FAILURE);
});
function shutdown(){ try{ fs.unlinkSync(PIDFILE); }catch(e){} try{ server.close(); }catch(e){} process.exit(0); }
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
