---
name: fugu
description: Run Claude Code on the Sakana Fugu model (api.sakana.ai). Use when the user wants to use Fugu / fugu-ultra as the backend for Claude Code, asks to "switch to Fugu", mentions Sakana Fugu with Claude Code, or wants an OpenAI-compatible backend bridged to Claude Code. Starts a bundled local translation proxy (Anthropic Messages <-> OpenAI Chat Completions) and explains how to launch Claude Code against it.
---

# Run Claude Code on Sakana Fugu

Claude Code only speaks the **Anthropic Messages API** (`POST /v1/messages`).
Sakana Fugu exposes **OpenAI-compatible** endpoints only
(`/v1/chat/completions`, `/v1/responses`); it has **no `/v1/messages`** (404).
So Claude Code cannot connect to Sakana directly. This skill bundles a tiny,
dependency-free Node proxy that translates between the two, plus a launcher.

Billing goes to **your own `SAKANA_API_KEY`** — no OpenRouter, no third party.

## Important: you cannot switch the *current* session to Fugu

A running Claude Code session's backend is fixed at launch (by `ANTHROPIC_BASE_URL`).
A skill runs *inside* an already-started session, so it **cannot** retarget the
session you are in. What this skill does is **set up the gateway and start a
NEW Claude Code process** that talks to Fugu. Tell the user this plainly.

## Prerequisites

- `node` (v18+), `curl`, and `nc` available on PATH.
- `claude` (Claude Code CLI) installed.
- `SAKANA_API_KEY` exported in the environment. If it is missing, ask the user
  to run `export SAKANA_API_KEY=<their key>` — never hardcode or echo the key.

## Steps

1. **Check the key is set** (do not print its value):
   ```bash
   [ -n "$SAKANA_API_KEY" ] && echo "key: set" || echo "key: MISSING — ask user to export SAKANA_API_KEY"
   ```

2. **Start the proxy** (idempotent; skip if `:4000` already listening). Run from
   this skill's directory so the relative path resolves:
   ```bash
   nc -z 127.0.0.1 4000 2>/dev/null || \
     setsid node ./fugu-proxy.js >./proxy.out 2>&1 &
   curl -s -o /dev/null --retry 40 --retry-delay 1 --retry-connrefused --max-time 3 \
     -X POST http://127.0.0.1:4000/v1/messages/count_tokens \
     -H 'content-type: application/json' -d '{}' && echo "proxy ready"
   ```

3. **Health-check through the proxy** (optional; proves the whole path works):
   ```bash
   curl -s --max-time 60 -X POST http://127.0.0.1:4000/v1/messages \
     -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' \
     -d '{"model":"fugu","max_tokens":32,"messages":[{"role":"user","content":"reply with exactly: READY"}]}'
   ```

4. **Tell the user how to launch Claude Code on Fugu.** Either the bundled
   launcher (recommended), or manual env:
   ```bash
   # Recommended: the bundled launcher (auto-starts the proxy too)
   ./claude-fugu                       # interactive
   FUGU_MODEL=fugu-ultra ./claude-fugu # Fugu Ultra

   # Manual equivalent:
   export ANTHROPIC_BASE_URL="http://127.0.0.1:4000"
   export ANTHROPIC_AUTH_TOKEN="proxy-local"   # ignored by the proxy
   unset ANTHROPIC_API_KEY
   claude --model fugu
   ```

   For convenience, the launcher can be symlinked onto PATH:
   ```bash
   ln -sf "$PWD/claude-fugu" ~/.local/bin/claude-fugu
   ```

## Models

- `FUGU_MODEL=fugu` (default) or `fugu-ultra`. The proxy also routes by the
  `--model` you pass to Claude Code (anything containing "ultra" → `fugu-ultra`).

## Notes & caveats

- This is an **unofficial** bridge; a Sakana/Anthropic API change can break it.
- The proxy listens on **localhost only** — do not expose the port.
- Upstream is **Chat Completions** (the robust target for tool use + streaming).
- Fugu Ultra can be slow (internal orchestration); long turns are expected.
- The proxy reads `SAKANA_API_KEY` from the environment at runtime and stores no
  secret in any file. Never commit `proxy.out` / `proxy.log`.
