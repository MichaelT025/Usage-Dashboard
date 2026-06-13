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
