# llm-usage

> Local LLM subscription usage monitor — terminal by default, with an optional web dashboard.

![license](https://img.shields.io/badge/license-Apache%202.0-blue)
![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

---

## Overview

`llm-usage` polls provider usage APIs to give you a single-pane view of your LLM subscription limits. By default it prints a snapshot to your terminal and exits. Nothing leaves your machine except authenticated requests to the configured providers, and credentials are never logged or included in dashboard responses.

**Supported providers:**

| Provider    | Data source                          | What you see                             |
| ----------- | ------------------------------------ | ---------------------------------------- |
| Claude      | `api.anthropic.com/api/oauth/usage`  | 5h / weekly / per-model windows, credits |
| Codex       | `chatgpt.com/backend-api/wham/usage` | Rate-limit windows, plan type, credits   |
| OpenCode Go | `opencode.ai/zen/go/v1/usage`        | Rolling / weekly / monthly quotas        |

Zen and OpenRouter stubs are wired but not yet implemented.

---

## Quick start

```bash
# Install globally
npm install -g llm-usage

# Run the interactive setup wizard
llm-usage setup

# Print a usage snapshot to the terminal
llm-usage

# Live auto-refreshing terminal UI
llm-usage --watch

# Launch the web dashboard (old default)
llm-usage --dash
# Open http://localhost:7878 in your browser
```

### One-shot usage (no global install)

```bash
npx llm-usage setup
npx llm-usage
```

---

### Note for existing users

Previously, `llm-usage` launched the web dashboard by default. As of this version, the default output is a terminal snapshot that prints and exits immediately.

To restore the web dashboard behavior:

```bash
llm-usage --dash
```

---

## Setup details

### Claude

Claude credentials are read automatically from `~/.claude/.credentials.json` (created by the Claude Code CLI when you run `claude`). No manual configuration needed.

If the terminal output shows "not configured," log into Claude Code once:

```bash
claude
```

### Codex

Codex credentials are read from the Codex CLI auth store. Log in once:

```bash
codex login
```

### OpenCode Go

OpenCode Go usage is read from its official usage API. The API key is discovered automatically in this order:

1. `OPENCODE_API_KEY`
2. The `opencode-go` entry in `~/.local/share/opencode/auth.json`
3. The `opencode` entry in the same auth file, because Zen and Go can share a workspace key

To configure the key through OpenCode, run `/connect` in the OpenCode TUI, select **OpenCode Go**, and paste the key from the OpenCode console. Set `OPENCODE_AUTH_PATH` only when the auth file is stored at a nonstandard location.

The endpoint reports Go subscription quotas only. It does not report ordinary Zen pay-as-you-go spending or the Zen credit balance.

---

## Command-line reference

```
llm-usage                 Print a usage snapshot to the terminal and exit (default)
llm-usage --watch         Live auto-refreshing terminal UI (alias: --tui)
llm-usage --json          Print a machine-readable JSON snapshot and exit
llm-usage --dash          Launch the local web dashboard
llm-usage setup           Interactive setup wizard
llm-usage setup --check   Check provider configuration status
llm-usage --help          Show usage
```

`--watch`/`--tui`, `--json`, and `--dash` are mutually exclusive. Combining them exits with an error.

| Option             | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `--port N`         | Server port (default: `7878`) — only applies with `--dash`        |
| `--no-open`        | Don't open the browser automatically — only applies with `--dash` |
| `--watch`, `--tui` | Live TUI — requires an interactive terminal (TTY)                 |
| `--json`           | Machine-readable JSON output — color disabled, always exits 0     |

Color is auto-disabled when output is piped or the `NO_COLOR` environment variable is set.

---

## Configuration

Application settings live at `~/.llm-usage/config.json`:

| Key                             | Type   | Default | Description                                  |
| ------------------------------- | ------ | ------- | -------------------------------------------- |
| `refreshIntervalSec`            | number | `180`   | Seconds between auto-refresh polls (min: 30) |
| `port`                          | number | `7878`  | HTTP server port                             |
| `claudeCredentialsPathOverride` | string | —       | Override path to Claude credentials file     |
| `codexAuthPathOverride`         | string | —       | Override path to Codex credentials store     |

OpenCode workspace IDs and browser cookies are no longer required. Existing `opencodeWorkspaceId` and `opencodeAuthCookie` properties are legacy scraper settings and can be removed from the file.

OpenCode credential discovery can be adjusted with these environment variables:

| Variable             | Description                                           |
| -------------------- | ----------------------------------------------------- |
| `OPENCODE_API_KEY`   | OpenCode API key; takes precedence over the auth file |
| `OPENCODE_AUTH_PATH` | Override path to the OpenCode CLI `auth.json` file    |

**Do not commit credential files or API keys.** Configuration files are written with `0600` permissions on POSIX systems.

---

## API endpoints

> API endpoints are only available when running `llm-usage --dash`.

All endpoints are local-only (`http://127.0.0.1:7878`).

| Method | Path           | Description                                  |
| ------ | -------------- | -------------------------------------------- |
| `GET`  | `/`            | Dashboard UI                                 |
| `GET`  | `/api/status`  | Current usage snapshot for all providers     |
| `POST` | `/api/refresh` | Force an out-of-cycle poll                   |
| `GET`  | `/api/config`  | Configuration status (never returns secrets) |
| `POST` | `/api/config`  | Update configuration (same-origin only)      |

The `POST /api/config` endpoint is guarded against cross-origin requests and rejects payloads larger than 8 KB.

---

## Architecture

```
src/
├── cli.ts              CLI entrypoint — flag parsing, terminal/JSON/TUI/web dispatch
├── server.ts           HTTP server — routing, static file serving, config CRUD
├── setup.ts            Interactive setup and provider credential checks
├── render.ts           Pure ANSI terminal formatter functions (bar, colors, frame builder)
├── tui.ts              Live alt-screen TUI loop (Poller-driven, 1s countdown re-render, key/resize/signal handling)
├── core/
│   ├── types.ts        Pure data contracts (UsageData, QuotaWindow, StatusResponse)
│   ├── config.ts       Load / validate / save config (~/.llm-usage/config.json)
│   ├── credentials.ts  Read Claude, Codex, and OpenCode credentials from local auth stores
│   ├── poller.ts       Polling service — interval, backoff, deduplication
│   ├── aggregator.ts   Parallel fetch across adapters, merge results
│   ├── redact.ts       Strip secrets from error messages and response bodies
│   └── paths.ts        Filesystem paths for config and credential stores
├── providers/
│   ├── claude.ts       Anthropic OAuth usage API adapter
│   ├── codex.ts        ChatGPT backend usage API adapter
│   ├── opencode-go.ts  Official OpenCode Go usage API adapter
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
