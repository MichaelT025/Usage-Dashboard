# llm-usage

> Local web dashboard showing LLM subscription usage for Claude, Codex, and OpenCode Go — all in one place.

![license](https://img.shields.io/badge/license-Apache%202.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

---

## Overview

`llm-usage` polls usage APIs and scrapes provider pages to give you a single-pane view of your LLM subscription limits. It runs a lightweight HTTP server on `127.0.0.1` — nothing leaves your machine, and credentials are never logged or transmitted off-device.

**Supported providers:**

| Provider     | Data source                             | What you see                              |
| ------------ | --------------------------------------- | ----------------------------------------- |
| Claude       | `api.anthropic.com/api/oauth/usage`     | 5h / weekly / per-model windows, credits  |
| Codex        | `chatgpt.com/backend-api/wham/usage`    | Rate-limit windows, plan type, credits    |
| OpenCode Go  | HTML scrape of `opencode.ai` Go console | Rolling / weekly / monthly, balance       |

Zen and OpenRouter stubs are wired but not yet implemented.

---

## Quick start

```bash
# Install globally
npm install -g llm-usage

# Run the interactive setup wizard
llm-usage setup

# Start the dashboard
llm-usage
```

Open `http://localhost:7878` in your browser (it opens automatically unless you pass `--no-open`).

### One-shot usage (no global install)

```bash
npx llm-usage setup
npx llm-usage
```

---

## Setup details

### Claude

Claude credentials are read automatically from `~/.claude/.credentials.json` (created by the Claude Code CLI when you run `claude`). No manual configuration needed.

If the dashboard shows "not configured," log into Claude Code once:

```bash
claude
```

### Codex

Codex credentials are read from the Codex CLI auth store. Log in once:

```bash
codex login
```

### OpenCode Go

OpenCode Go requires manual configuration — it has no public API and authenticates via a session cookie.

1. Navigate to `https://opencode.ai/workspace/{ID}/go` in your browser.
2. Open DevTools → Application → Cookies → `opencode.ai`.
3. Copy the value of the `auth` cookie.
4. Run `llm-usage setup` and paste both your workspace ID and the cookie value.

The wizard masks input so the cookie value is never echoed to the terminal.

---

## Command-line reference

```
llm-usage [options]           Start the dashboard
llm-usage setup               Interactive setup wizard
llm-usage setup --check       Check provider configuration status
llm-usage setup --no-validate Skip live credential validation
llm-usage --help              Show usage
```

| Option     | Description                           |
| ---------- | ------------------------------------- |
| `--port N` | Server port (default: `7878`)         |
| `--no-open` | Don't open the browser automatically |

---

## Configuration

Config lives at `~/.llm-usage/config.json`. Fields:

| Key                    | Type   | Default | Description                                            |
| ---------------------- | ------ | ------- | ------------------------------------------------------ |
| `refreshIntervalSec`   | number | `180`   | Seconds between auto-refresh polls (min: 30)            |
| `port`                 | number | `7878`  | HTTP server port                                        |
| `opencodeWorkspaceId`  | string | —       | Your OpenCode workspace ID                              |
| `opencodeAuthCookie`   | string | —       | Session cookie from `opencode.ai`                       |
| `claudeCredentialsPathOverride` | string | — | Override path to Claude credentials file       |
| `codexAuthPathOverride` | string | —       | Override path to Codex credentials store                |

**Do not commit this file** — it may contain credentials. It is stored with `0600` permissions on POSIX systems.

---

## API endpoints

All endpoints are local-only (`http://127.0.0.1:7878`).

| Method | Path           | Description                                    |
| ------ | -------------- | ---------------------------------------------- |
| `GET`  | `/`            | Dashboard UI                                   |
| `GET`  | `/api/status`  | Current usage snapshot for all providers       |
| `POST` | `/api/refresh` | Force an out-of-cycle poll                     |
| `GET`  | `/api/config`  | Configuration status (never returns secrets)   |
| `POST` | `/api/config`  | Update configuration (same-origin only)        |

The `POST /api/config` endpoint is guarded against cross-origin requests and rejects payloads larger than 8 KB.

---

## Architecture

```
src/
├── cli.ts              CLI entrypoint — flag parsing, setup delegation, server bootstrap
├── server.ts           HTTP server — routing, static file serving, config CRUD
├── setup.ts            Interactive setup wizard with masked credential input
├── core/
│   ├── types.ts        Pure data contracts (UsageData, QuotaWindow, StatusResponse)
│   ├── config.ts       Load / validate / save config (~/.llm-usage/config.json)
│   ├── credentials.ts  Read Claude & Codex tokens from their CLI auth stores
│   ├── poller.ts       Polling service — interval, backoff, deduplication
│   ├── aggregator.ts   Parallel fetch across adapters, merge results
│   ├── redact.ts       Strip secrets from error messages and response bodies
│   └── paths.ts        Filesystem paths for config dir / file
├── providers/
│   ├── claude.ts       Anthropic OAuth usage API adapter
│   ├── codex.ts        ChatGPT backend usage API adapter
│   ├── opencode-go.ts  HTML-scraping adapter for OpenCode Go console
│   ├── openrouter.ts   Stub (Phase 2)
│   ├── zen.ts          Stub (Phase 2)
│   └── stubs.test.ts   Shared test fixtures
└── smoke.test.ts       Integration smoke test
public/
├── index.html          Dashboard shell
├── app.js              Frontend logic — fetch, render, settings modal
└── styles.css          Dashboard styles
```

### Key design decisions

- **Zero external runtime dependencies.** Only `fetch`, Node.js `http`, `fs`, and `path` are used at runtime. Dev dependencies are TypeScript, Vitest, and tsx.
- **Adapter interface.** Every provider implements `IProviderAdapter` (`id`, `displayName`, `fetch()`). `fetch()` resolves with structured data or an error variant — it never throws.
- **Poller concurrency.** If a poll is in flight, `refreshNow()` returns the same promise. After a 429, that adapter skips 2 cycles.
- **Credential safety.** Secrets are stripped from all error messages, log output, and API responses via the `redactSecrets` utility. The server binds to `127.0.0.1` only.
- **First-run experience.** If no config exists, an example file is created automatically.

---

## Development

```bash
# Install dependencies
npm install

# Type-check
npm run typecheck

# Run dev server with hot-reload (tsx)
npm run dev

# Run tests
npm test

# Build for production
npm run build
```

### Running tests

Tests use Vitest:

```bash
npx vitest run           # single run
npx vitest               # watch mode
```

---

## License

[Apache 2.0](LICENSE)
