# Business-validation status

Updated 2026-08-30.

## Current conclusion

The Worker is **live**. The business experiment has **not** succeeded.

Business status: **WAITING FOR FIRST ORGANIC TOOL CALL**.

Genuine business counters are all **0**. Only post-cutover, external, non-verification,
non-owned `tools/call` events for an exact UpgradeLens tool whose handler ran and
returned semantic success count as business demand. Until those counters move — or
the 45-day kill/pivot window ends — do not classify the experiment as successful
or failed.

## Live production

- Public Worker: `https://upgradelens.mattpicone.workers.dev`
- `/healthz`: `db=ok`, `telemetry_schema=ok`
- `counts_reset_at`: `2026-08-29T19:57:23.228Z` — do not reset again
- Owner-tagged MCP traffic is classified `internal` and does not increment
  business counters
- Worker version 0.2.2 is deployed. Browser/Electron Origins now work, CORS
  preflight returns 204, legacy 2025 clients remain supported, and current
  stateless 2026-07-28 discovery/tool envelopes are implemented
- Official MCP Registry listing `io.github.mattpicone/upgradelens` v0.2.2 is
  published and active; the live UI card and API record were verified
- PulseMCP returns 0 servers. Glama's servers page is absent; connector listing:
  https://glama.ai/mcp/connectors/io.github.mattpicone/upgradelens. Cursor,
  Gemini gallery, Claude directory, Smithery, and general search have no live
  UpgradeLens listing as of 2026-08-30
- GitHub Actions deploy is **skipped**: repository secret `CLOUDFLARE_API_TOKEN`
  is not configured. `OWNER_TOKEN` is configured on GitHub and would run the
  owner-tagged MCP verify after a CI deploy
- Owner dashboard: cookie login at `/dashboard` (paste `OWNER_TOKEN` once; Bearer
  auth still works for scripts)

## What still does not count

`initialize`, `tools/list`, registry/auth/security/health/crawler traffic, owner
smoke tests, unknown tools, invalid keys, and unsuccessful calls are not organic
business demand.

## Local engineering (cutover session)

- `npm run typecheck` passed.
- `npm test` passed (133 tests).
- Three-pass MCP selection scorer passed: 30/30 labels and sequences per pass.
- Production probes passed: `/healthz` version 0.2.2 with `db=ok` and
  `telemetry_schema=ok`; Cursor-origin POST 200 with CORS; OPTIONS 204; unknown
  protocol 400 with `-32022` and supported versions; current discovery 200.
- The installed Codex `0.150.0-alpha.8` client was configured using
  `codex mcp add`, showed UpgradeLens enabled, discovered its tools, and made
  one owner-tagged `check_dependency_upgrade` call. It received
  `review_required`, `action_allowed=false`, confidence 0.95 and four evidence
  records.
- `scripts/verify-production-mcp.mjs` is the guarded owner smoke test. It refuses
  to send MCP traffic until `/healthz` reports `db=ok` and `telemetry_schema=ok`,
  then owner-tags `initialize`, `tools/list`, and all three `tools/call` tools and
  reads the owner dashboard.
- Migration `0005_dashboard_reset.sql` recorded the zero-count baseline in
  `dashboard_state.counts_reset_at`; dashboard aggregates exclude earlier rows
  while retaining them for audit.

## Remaining external gates

- Add GitHub repo secret `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit + D1:Edit)
  so `.github/workflows/ci.yml` deploys on `main`. `OWNER_TOKEN` is already set.
- Cursor Marketplace, cursor.directory, Claude's directory, Smithery publish,
  and Glama claim require authenticated owner/account review flows. None is
  claimed as submitted or accepted. Details and exact URLs are in
  `docs/DISTRIBUTION.md`.
- Do not enable payments, add ecosystems, or reset the dashboard clock.

## Genuine counters after verification

- Successful organic business calls: 0
- Genuine tool clients: 0
- Repeat genuine tool clients: 0
- Stable keyed genuine clients: 0
- Anonymous/IP-derived genuine identities: 0
- Internal owner calls today: 4
- External discovery/protocol events: 525 from 52 privacy-preserving identities
- State: `WAITING FOR FIRST ORGANIC TOOL CALL` (day 1 of 45)
