# Command Code Usage Integration Plan

## Goal

Add Command Code as a usage source in `llm-usage`. The feature adds a Command Code card beside Claude, Codex, and OpenCode Go; it does **not** add prompt generation or a general model-calling API.

## Scope

- Discover Command Code credentials from `COMMAND_CODE_API_KEY` and `~/.commandcode/auth.json`.
- Read account plan, subscription credits, and quota windows through the account/usage API available to the installed Command Code CLI.
- Normalize the result into the existing `UsageData` contract.
- Support coding plans such as Go, GOAT, Pro, Max, and Team.
- Represent the Provider plan as credits/balance-only when it has no rolling subscription windows.
- Preserve credential safety and per-provider failure isolation.
- Use the supplied Command Code icon as `public/icons/command-code.svg` (or an equivalent safe SVG asset if the binary attachment is not available to the workspace).

## Important API distinction

The documented Provider API at `https://api.commandcode.ai/provider/v1` is for making model requests (`/chat/completions`, `/responses`, `/messages`, and `/models`). It is not the usage endpoint needed by this dashboard. Usage discovery must therefore confirm the account/billing endpoints used by the installed CLI, likely under `/alpha`.

Candidate read-only endpoints to verify:

- `/alpha/whoami`
- `/alpha/billing/credits`
- `/alpha/billing/subscriptions`
- `/alpha/usage/summary`

These endpoints are not treated as stable until their response shapes are verified. Unknown or changed responses must become `PARSE`/`UNAVAILABLE`, never zero usage.

## Current architecture constraints

- Provider identity and normalized data live in `src/core/types.ts`.
- Credentials and platform-specific paths live in `src/core/credentials.ts` and `src/core/paths.ts`.
- Provider adapters live in `src/providers/` and must resolve with `UsageData` rather than reject.
- Active adapters are registered in both `src/cli.ts` and `src/server.ts`.
- Setup status is handled in `src/setup.ts`.
- The dashboard card renderer in `public/app.js` is generic; the settings drawer has provider-specific status rows.
- The repository intentionally has no runtime dependencies beyond Node APIs.

## Current implementation status

Implementation is complete through the first integration milestone. The current working decisions are:

- Command Code is tracked as a dashboard usage source, not a model-generation provider.
- Provider-plan accounts are included as credits-only cards.
- Credit pools are represented as one aggregate balance because the existing `CreditsInfo` contract has no separate pool fields.
- The alpha account endpoints are used best-effort with schema validation, safe degradation, and sanitized fixtures.
- The attached icon could not be copied as a binary workspace file, so `public/icons/command-code.svg` contains a local monochrome fallback mark; the card also has the existing monogram fallback.

Completed implementation work includes credential discovery, response parsing, adapter tests, CLI/server/setup registration, settings status, documentation, and integration checks. The setup/add CLI now includes enriched `setup` output (config file, port, refresh interval) and a safe guided `llm-usage add` flow (TTY menu, `<provider-id>` selection, `--list`/`--help`, idempotent already-configured reporting, official login instructions only, no secret handling). Live authenticated endpoint verification remains intentionally separate because the usage API is undocumented and account-specific.

## Phases and tasks

### Phase 0 — Product contract

- [ ] Confirm the feature is live Command Code usage tracking, not model generation or saved Plan Mode files.
- [ ] Confirm whether Provider-plan balance should be included in the first release.
- [ ] Confirm whether separate standard/premium Max pools must be displayed or whether aggregate credits are sufficient.

### Phase 1 — Discovery spike (parallel)

#### A. Credential discovery

- [ ] Inspect the local Command Code auth file without printing secrets.
- [ ] Confirm token field and environment-variable precedence.
- [ ] Confirm cross-platform auth path behavior.

#### B. API/schema discovery

- [ ] Verify the API base and required headers.
- [ ] Safely request sanitized account, subscription, credits, and usage responses.
- [ ] Record field names, optional fields, timestamp formats, and account-specific behavior.
- [ ] Verify Go, coding-plan, and Provider-plan behavior where available.

#### C. Data-model mapping

- [ ] Map five-hour, weekly, and monthly data to `QuotaWindow`.
- [ ] Decide whether `CreditsInfo` can represent included and purchased credits.
- [ ] Define readable plan-label normalization.

#### D. UI/test audit

- [ ] Confirm the generic provider card needs no structural changes.
- [ ] Identify settings/status rows and icon asset changes.
- [ ] Define sanitized fixtures and failure cases.

### Phase 2 — Core contract and credentials (parallel after discovery)

- [x] Add `command-code` to `ProviderId` (code complete).
- [x] Add a Command Code auth path helper (code complete).
- [x] Add `getCommandCodeToken()` with environment-first, auth-file fallback (code complete).
- [x] Add credential tests that never use or print real secrets (code complete).
- [x] Extend `CreditsInfo` only if the verified response shape requires it (not required; aggregate balance used).

### Phase 3 — Parser and adapter

- [x] Add pure parsers for subscription, credits, usage windows, and timestamps (code complete; live shape verification pending).
- [x] Add sanitized response fixtures (code complete).
- [x] Add `CommandCodeAdapter` with structured error handling (code complete).
- [x] Cover missing auth, 401, 403/upgrade-required, 429, network, malformed, and partial responses (code complete).
- [x] Ensure the adapter never leaks tokens in errors or serialized output (code complete).

### Phase 4 — Application wiring (parallel once adapter contract is stable)

- [x] Register the adapter in `src/cli.ts` (code complete; live authenticated output pending).
- [x] Register the adapter in `src/server.ts` (code complete; live authenticated output pending).
- [x] Add setup status in `src/setup.ts` (required Claude+Codex+OpenCode Go for `--check`; Command Code optional; enriched config/port/interval output; guided `add` flow with pure status/selection helpers).
- [x] Add a boolean-only `commandCodeTokenFound` field to `/api/config` (code complete; live verification pending).
- [x] Add the Command Code status row to the settings drawer (code complete; live verification pending).
- [x] Add `public/icons/command-code.svg` as a local fallback mark (not supplied artwork; supplied asset unavailable as a workspace file).
- [x] Update README provider, credential, API-source, and architecture sections (code complete).

### Phase 5 — Verification and hardening

- [x] Add aggregator/status integration coverage (code-level; live provider verification pending).
- [ ] Verify one provider failure does not hide the other cards.
- [ ] Run typecheck, tests, and production build.
- [ ] Review the complete diff for secret leakage, unsafe redirects, and accidental model-calling behavior.
- [ ] Document the alpha endpoint risk and graceful degradation behavior.

Latest verification update (supersedes pending live-account notes above): authenticated alpha responses and the built adapter have now been checked against an inactive GOAT account. The adapter returns 5h and weekly windows with null resets (starts on first use), plus a monthly window derived from included credits consumed/remaining and the actual billing cycle. All 128 tests, typecheck, and build pass. Multi-plan, active-usage, and visual dashboard checks remain pending.

## Dependency graph

```text
Phase 0 scope
    |
    +--> Credential discovery ----+
    +--> API/schema discovery -----+--> Core contract + credential loader
    +--> Data-model mapping -------+              |
    +--> UI/test audit             |              v
                                   +------> Parser + adapter
                                                  |
                         +------------------------+------------------+
                         v                        v                  v
                    CLI wiring              Server/setup        Icon/docs
                         +------------------------+------------------+
                                                  v
                                      Integration checks/review
```

## Acceptance criteria

- `llm-usage` and `llm-usage --json` include a Command Code entry.
- The dashboard displays Command Code plan and verified usage data when configured.
- Unconfigured Command Code is clearly reported without making other providers fail.
- Provider-plan accounts can be represented without fake quota windows.
- API/schema failures show an actionable error instead of fabricated zero values.
- No credentials appear in logs, errors, fixtures, JSON responses, or the UI.
- Existing Claude, Codex, and OpenCode Go behavior remains unchanged.
- `npm run typecheck`, `npm test`, and `npm run build` pass.

## Risks and mitigations

| Risk                                             | Mitigation                                                                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Usage API is undocumented/alpha                  | Isolate all calls in one adapter, validate every response, add fixtures, fail as `PARSE` rather than zero. |
| Auth file schema differs across versions         | Support environment override, validate shape, and keep path/credential loading separate from parsing.      |
| Provider plan has no quota windows               | Return an empty window list and show credits only.                                                         |
| Max plans expose multiple credit pools           | Start with aggregate values; extend the model only when verified and required.                             |
| Existing provider registration is duplicated     | Make the smallest safe change first; defer registry refactoring unless tests show it is worthwhile.        |
| Supplied icon is unavailable as a workspace file | Preserve the supplied visual intent with a safe local SVG and keep the frontend monogram fallback.         |
