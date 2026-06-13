## Conventions & Patterns
- Stack: TypeScript / Node 20+, ESM modules ("type":"module"), NodeNext resolution
- No axios/node-fetch — native etch only
- No frontend build pipeline — vanilla HTML/CSS/JS in public/
- All paths via os.homedir(), never process.env.HOME
- Secret redaction: always run errors through edactSecrets() from src/core/redact.ts
- Provider isolation: Promise.allSettled — one failure never breaks others
- Single feature branch: eat/usage-dashboard; never commit to main
- Conventional commits, one per task, only after tests pass
## [2026-06-13] Task T2 complete
- src/core/types.ts written with all 7 exports
- Confirmed zero imports, zero presentation fields
- StatusResponse shape: { providers: UsageData[], generatedAt: string }
## [2026-06-13] Task T3 complete
- src/core/redact.ts: redactSecrets + safeErrorMessage, tested
- src/core/paths.ts: configPath, claudeCredentialsPath, codexAuthPath — all os.homedir()-based, env-overridable
- Secret patterns covered: sk-ant-*, sk-*, Fe26.2**, Bearer
- Sensitive keys: authorization, cookie, token, access_token, apikey, api_key, key, password, credentials
## [2026-06-13] Task T5 complete
- credentials.ts: getClaudeToken (file-first, WCM fallback on win32), getCodexToken (auth.json + JWT account id decode)
- Re-reads files on every call — no module-scope caching
- JWT decode: Buffer.from(segment, 'base64url') — no npm dep
- WCM: PowerShell Get-StoredCredential — wrap in try/catch, best-effort
## [2026-06-13] Task T4 complete
- src/core/config.ts: loadConfig (defaults+merge), validateConfig (secret-free errors), saveConfig (atomic write, chmod 0600), writeExampleConfig
- Defaults: refreshIntervalSec=180, port=7878, MIN_REFRESH_SEC=30
- saveConfig uses rename for atomicity; creates dir if missing
## [2026-06-13] Task T6 complete
- zen.ts + openrouter.ts: not_implemented stubs implementing IProviderAdapter
- NOT in active aggregator list — Phase-2 seams only
- Phase-2 future: OpenRouter GET /api/v1/key; Zen HTML scrape or cost accumulation

## [2026-06-13] Task T11 complete
- public/index.html + app.js + styles.css — vanilla, no build step
- Cards: ok (bars + countdowns), unavailable/unconfigured (hint card, no bars)
- Auto-refresh 180s, manual refresh button with debounce
- Gear button placeholder: toggles .hidden on #settings-modal
- not_implemented providers filtered out before render
- Color thresholds: <80% green, >=80% amber, 100% red
