# fugu-claude-code-gateway

Run **Claude Code** on the **Sakana Fugu** model, billed to your own Sakana key.
Cross-platform (macOS/Linux), dependency-free Node proxy. No OpenRouter, no third party.

## Why this exists

Claude Code only speaks the **Anthropic Messages API** (`POST /v1/messages`).
Sakana exposes **OpenAI-compatible** faces only:

| Endpoint (same Sakana key) | Used by | Result |
|---|---|---|
| `POST /v1/chat/completions` | Codex, Cursor | 200 |
| `POST /v1/responses` | Codex (`wire_api=responses`) | 200 |
| `POST /v1/messages` | **Claude Code** | **404 Not Found** |

So Codex attaches directly; Claude Code can't, because Sakana has no
`/v1/messages`. This skill bundles a ~150-line proxy that bridges it: it accepts
Anthropic Messages from Claude Code, translates to Sakana Chat Completions, and
translates the reply (streaming SSE + tool calls) back.

> Note: a skill runs *inside* an already-started Claude Code session and **cannot**
> retarget that session. It sets up the gateway and you launch a **new** Claude
> Code process (`claude-fugu`) that talks to Fugu.

## Install

### As a plugin (recommended)

Inside Claude Code:

```
/plugin marketplace add JinZhongcun/fugu-claude-code-gateway
/plugin install fugu-claude-code-gateway@fugu-gateway
```

(`fugu-gateway` is the marketplace name from `.claude-plugin/marketplace.json`;
`fugu-claude-code-gateway` is the plugin name.)

### Manual (clone + symlink the skill)

```bash
git clone https://github.com/JinZhongcun/fugu-claude-code-gateway
ln -s "$(pwd)/fugu-claude-code-gateway/skills/fugu" ~/.claude/skills/fugu
```

## Use

```bash
export SAKANA_API_KEY=your-sakana-key      # required

# one command — auto-starts the proxy and launches Claude Code on Fugu:
./skills/fugu/claude-fugu                  # interactive
./skills/fugu/claude-fugu -p "hello"       # one-shot
FUGU_MODEL=fugu-ultra ./skills/fugu/claude-fugu   # Fugu Ultra
```

Or, inside a running Claude Code session, invoke the **`fugu`** skill and it will
start the proxy and tell you exactly how to launch.

## Requirements

- `node` v18+, `curl`, `nc`
- `claude` (Claude Code CLI)
- A Sakana API key in `SAKANA_API_KEY`

## How it works

```
Claude Code ──(Anthropic /v1/messages)──▶ fugu-proxy.js ──(OpenAI /v1/chat/completions)──▶ Sakana Fugu
            ◀──(Anthropic reply / SSE)───              ◀──(OpenAI reply)──────────────────
```

- Upstream is **Chat Completions** (robust for tool use + streaming).
- The proxy reads `SAKANA_API_KEY` from the environment at runtime and stores no
  secret on disk. It listens on **localhost only**.

## Caveats

- **Unofficial.** A Sakana/Anthropic API change can break it. Use at your own risk.
- Fugu Ultra can be slow (internal orchestration); long turns are expected.
- A model's self-reported "what I changed" can be wrong — verify with diffs.

## Prior art

- [`musistudio/claude-code-router`](https://github.com/musistudio/claude-code-router) — general Anthropic↔OpenAI router; Sakana works as a user-added custom provider.
- LiteLLM proxy in Anthropic-passthrough mode — another translation path.

This repo is a minimal, readable, single-purpose alternative you can audit end to end.

## License

MIT — see [LICENSE](LICENSE).
