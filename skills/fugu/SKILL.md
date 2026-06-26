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

## What to do

Don't hand-roll the proxy startup. Drive everything through two bundled commands
(run them from this skill's directory; they resolve their own paths):

1. **Confirm the key is set — never print its value.** If missing, ask the user to
   `export SAKANA_API_KEY=<their key>`.
   ```bash
   [ -n "$SAKANA_API_KEY" ] && echo "key: set" || echo "key: MISSING"
   ```

2. **Tell the user to launch with `claude-fugu`** (it starts the gateway if needed,
   verifies the port really belongs to this gateway via `/health`, then launches
   Claude Code):
   ```bash
   ./claude-fugu                       # interactive Claude Code on Fugu
   FUGU_MODEL=fugu-ultra ./claude-fugu # Fugu Ultra
   ```
   Symlink it onto PATH for convenience: `ln -sf "$PWD/claude-fugu" ~/.local/bin/claude-fugu`.

3. **If anything fails, run the doctor** (it never prints the key) and report the
   failing check:
   ```bash
   ./fugu-doctor
   ```

Manual equivalent, if the user can't use the launcher:
```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:4000"
export ANTHROPIC_AUTH_TOKEN="proxy-local"   # ignored by the proxy
unset ANTHROPIC_API_KEY
claude --model fugu
```

## Rules

- **Never print or log `SAKANA_API_KEY`.**
- **Don't trust an open port** — `claude-fugu` checks `/health` identifies as this
  gateway before routing Claude Code to it. Don't bypass that with a bare `nc -z`.
- **No silent model changes.** The gateway never falls back `fugu-ultra → fugu` on
  its own; failures are visible (`FUGU_ON_FAILURE=fail|advise`).
- The proxy binds `127.0.0.1` only — do not expose the port.
- `FUGU_MODEL=fugu` (default) or `fugu-ultra`; routing also honors `--model`
  (anything containing "ultra" → `fugu-ultra`).
- It's an **unofficial** bridge; a Sakana/Anthropic API change can break it.

See `references/compatibility.md` for the full feature matrix, failure policy,
timeouts, and config env vars.
