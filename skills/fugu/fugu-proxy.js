// fugu-proxy.js — let Claude Code drive Sakana Fugu.
//
// WHY: Claude Code only speaks the Anthropic Messages API (POST /v1/messages).
// Sakana exposes OpenAI-compatible faces only (/v1/chat/completions, /v1/responses);
// it has NO /v1/messages (returns 404). This proxy bridges the gap: it accepts
// Anthropic Messages requests from Claude Code, translates to Sakana's Chat
// Completions, and translates the reply (and SSE stream / tool calls) back.
//
// Auth: uses $SAKANA_API_KEY to call Sakana. The token Claude Code sends to THIS
// proxy is ignored. No OpenRouter involved — billed to your Sakana subscription.
//
// Run:  SAKANA_API_KEY=... PORT=4000 node fugu-proxy.js
// Deps: none (Node 18+, global fetch).
const http = require('http');
const fs   = require('fs');

const SAKANA_KEY    = process.env.SAKANA_API_KEY;
const UPSTREAM      = process.env.FUGU_UPSTREAM || 'https://api.sakana.ai/v1/chat/completions';
const DEFAULT_MODEL = process.env.FUGU_MODEL || 'fugu';     // used when request model is not a fugu variant
const EFFORT        = process.env.FUGU_EFFORT || '';         // optional: high|xhigh (passed as reasoning_effort; unverified on chat/completions)
const PORT          = parseInt(process.env.PORT || '4000', 10);
const LOG           = process.env.PROXY_LOG || (__dirname + '/proxy.log');

function log(s){ try{ fs.appendFileSync(LOG, '['+new Date().toISOString()+'] '+s+'\n'); }catch(e){} }
function readBody(req){ return new Promise((res,rej)=>{ let d=''; req.on('data',c=>d+=c); req.on('end',()=>res(d)); req.on('error',rej); }); }

// Route by the model name Claude Code sends (e.g. --model fugu-ultra), else default.
function pickModel(reqModel){
  if(reqModel && /ultra/i.test(reqModel)) return 'fugu-ultra';
  if(reqModel && /fugu/i.test(reqModel))  return 'fugu';
  return DEFAULT_MODEL;
}

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

const server=http.createServer(async (req,res)=>{
  try{
    if(req.method==='POST' && req.url.startsWith('/v1/messages/count_tokens')){
      const body=JSON.parse((await readBody(req))||'{}');
      const txt=JSON.stringify(body.messages||'')+JSON.stringify(body.system||'');
      res.writeHead(200,{'Content-Type':'application/json'});
      res.end(JSON.stringify({input_tokens:Math.ceil(txt.length/4)})); return;
    }
    if(req.method==='POST' && req.url.startsWith('/v1/messages')){
      const body=JSON.parse((await readBody(req))||'{}');
      const wantStream=!!body.stream;
      const oaReq=anthToOpenAI(body);
      log('IN model='+body.model+'->'+oaReq.model+' stream='+wantStream+' msgs='+(body.messages||[]).length+' tools='+((body.tools||[]).length));
      const r=await fetch(UPSTREAM,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+SAKANA_KEY},body:JSON.stringify(oaReq)});
      const text=await r.text();
      if(!r.ok){
        log('UPSTREAM '+r.status+' '+text.slice(0,300));
        res.writeHead(r.status,{'Content-Type':'application/json'});
        res.end(JSON.stringify({type:'error',error:{type:'api_error',message:'upstream '+r.status+': '+text.slice(0,500)}})); return;
      }
      let oaResp; try{ oaResp=JSON.parse(text); }catch(e){ oaResp={}; }
      const anth=openAIToAnth(oaResp, body.model);
      log('OUT ok blocks='+anth.content.length+' usage='+JSON.stringify(anth.usage));
      if(wantStream) streamAnth(res,anth);
      else { res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(anth)); }
      return;
    }
    res.writeHead(404,{'Content-Type':'application/json'}); res.end(JSON.stringify({error:'not found',path:req.url}));
  }catch(e){
    log('ERR '+(e&&e.stack||e));
    res.writeHead(500,{'Content-Type':'application/json'});
    res.end(JSON.stringify({type:'error',error:{type:'api_error',message:String(e)}}));
  }
});
// loopback only — never bind 0.0.0.0 (the proxy ignores the inbound token, so an
// exposed port = an open relay on your Sakana key). Override with FUGU_BIND if needed.
const BIND = process.env.FUGU_BIND || '127.0.0.1';
server.listen(PORT,BIND,()=>{ log('listening '+BIND+':'+PORT+' -> '+UPSTREAM+' default='+DEFAULT_MODEL+' effort='+(EFFORT||'(off)')); console.log('[fugu-proxy] '+BIND+':'+PORT+' -> Sakana ('+DEFAULT_MODEL+')'); });
