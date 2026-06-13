# llm-usage

Local dashboard showing LLM subscription usage for Claude, Codex, and OpenCode Go.

## Setup

```bash
npm install -g llm-usage   # or: npx llm-usage
llm-usage setup            # interactive config wizard
llm-usage                  # start dashboard at http://localhost:7878
```

Config stored at `~/.llm-usage/config.json` (never commit this file — it may contain credentials).

## OpenCode Go

Requires your workspace ID and `auth` session cookie from opencode.ai.
Run `llm-usage setup` or use the in-dashboard Settings panel.
