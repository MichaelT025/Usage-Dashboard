## Summary

- Add Command Code usage tracking to terminal, JSON, TUI, and web dashboard output.
- Show 5-hour, weekly, and monthly quotas. Inactive rolling windows display “Starts on first use”; monthly usage uses consumed included credits, remaining credits, and the billing-cycle reset.
- Discover credentials from `COMMAND_CODE_API_KEY` or the local auth store, with an optional path override.
- Bound account requests to 12 seconds, preserve rate-limit backoff, validate responses, and redact Command Code keys.
- Extend setup status and add a guided provider picker (`add`, `add <provider-id>`, `add --list`, `add --help`).
- Isolate server tests from real credentials and upstream requests.

## Verification

- `npm run typecheck` passed.
- `npm test` passed: 14 files, 128 tests.
- `npm run build` passed.
- Independent review completed; identified defects repaired with regression coverage.
- Live GOAT account verification returned all three windows, including inactive 5h/weekly quotas and monthly billing reset. No secrets or identity values were stored in fixtures.

## Notes

- Command Code account endpoints are undocumented `/alpha/*` routes; this feature does not call model inference endpoints.
- Live verification covers an inactive GOAT account, not every plan or an active/over-quota billing cycle.
- `QuotaWindow.resetsAt` can now be null for rolling windows that have not started; both renderers support it.
- Credits remain an aggregate balance; separate premium/standard pool presentation is deferred.
- `add` prints setup instructions without launching login programs or storing credentials. Exit 0 means help/list/already configured; exit 1 means missing configuration or invalid arguments.
- Existing `setup --check` semantics are preserved: Claude, Codex, and OpenCode Go required; Command Code optional.
- Icon is a light-colored local fallback, not the supplied artwork. Interactive browser visual verification remains outstanding.

## Review repairs

- Do not report healthy snapshots when requests fail or only a plan label is available.
- Correct bare-403 authentication and malformed-JSON parsing errors.
- Clamp over-quota windows and avoid double-counting credit pools.
- Prevent display names from becoming plan labels.
- Correct Windows login guidance and validate conflicting/extra CLI arguments.
- Fix duplicated terminal balance label and retain inactive quota windows.
