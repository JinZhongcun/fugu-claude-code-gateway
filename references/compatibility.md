# Compatibility

What the gateway translates between Claude Code (Anthropic Messages) and Sakana
(OpenAI Chat Completions), and what it does not. A small proxy is more trustworthy
when its limits are explicit.

| Feature | Status | Notes |
|---|---|---|
| text messages | **supported** | normal Claude Code turns |
| system prompt | **supported** | string and `text` blocks are joined |
| tools | **supported** | Anthropic `tools` → OpenAI `function` tools |
| tool_use / tool_result | **supported** | mapped to OpenAI `tool_calls` / `role:"tool"` messages |
| tool_choice | **supported** | `auto` / `any`→`required` / `tool`→named function |
| streaming response | **synthetic** | the upstream reply is received in full, then re-emitted as Anthropic SSE (not token-by-token) |
| count_tokens | **approximate** | `/v1/messages/count_tokens` returns `ceil(chars/4)`, not a real tokenizer |
| reasoning effort | **supported (opt-in)** | `FUGU_EFFORT=high\|xhigh\|max` → `reasoning_effort` (verified accepted by Sakana chat/completions) |
| model routing | **supported** | request model containing `ultra` → `fugu-ultra`, else `fugu` / `FUGU_MODEL` |
| automatic fallback | **disabled** | the gateway never switches models silently (see Failure policy) |
| image input | **unsupported** | image blocks are not mapped |
| prompt caching | **unsupported** | `cache_control` is not forwarded |
| Anthropic beta headers | **ignored** | passed through is not guaranteed |
| true upstream streaming | **unsupported** | upstream is called non-streaming |

## Failure policy

The gateway **never changes models silently.** If the upstream errors or times out,
the request fails visibly. There is no automatic `fugu-ultra → fugu` fallback.

- `FUGU_ON_FAILURE=fail` (default) — return the upstream error as-is.
- `FUGU_ON_FAILURE=advise` — same, plus a visible hint (retry, or run `FUGU_MODEL=fugu claude-fugu`).

## Timeouts

- `FUGU_TIMEOUT_MS` (default `300000` = 5 min) for `fugu`.
- `FUGU_ULTRA_TIMEOUT_MS` (default `900000` = 15 min) for `fugu-ultra` (it orchestrates a deeper pool and is slower).
- On timeout the request fails with a `504` and a clear message — no fallback.

## Networking / security

- Binds to `127.0.0.1` only by default. Override with `FUGU_BIND` (avoid exposing the port:
  the proxy ignores the inbound token, so an exposed port is an open relay on your Sakana key).
- Reads `SAKANA_API_KEY` from the environment at runtime; stores no secret on disk.
- Logs are structured JSON lines with a request id; message content / prompts / tool results are **never** logged.
