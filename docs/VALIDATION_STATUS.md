# Business-validation status

Updated 2026-08-29.

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
- Official MCP Registry listing `io.github.mattpicone/upgradelens` v0.2.1 is
  published and active; remotes point at the live `/mcp` URL
- PulseMCP submit form is closed (0 search hits). Glama servers page 404;
  connector listing: https://glama.ai/mcp/connectors/io.github.mattpicone/upgradelens
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
- `npm test` passed (127 tests).
- Three-pass MCP selection scorer passed: 30/30 labels and sequences per pass.
- `scripts/verify-production-mcp.mjs` is the guarded owner smoke test. It refuses
  to send MCP traffic until `/healthz` reports `db=ok` and `telemetry_schema=ok`,
  then owner-tags `initialize`, `tools/list`, and all three `tools/call` tools and
  reads the owner dashboard.
- Migration `0005_dashboard_reset.sql` recorded the zero-count baseline in
  `dashboard_state.counts_reset_at`; dashboard aggregates exclude earlier rows
  while retaining them for audit.

## Owner actions still required

- Add GitHub repo secret `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit + D1:Edit)
  so `.github/workflows/ci.yml` deploys on `main`. `OWNER_TOKEN` is already set.
- PulseMCP form closed; Glama add/claim needs owner GitHub login; cursor.directory
  has no free public add form. Details in `docs/DISTRIBUTION.md`.
- Do not enable payments, add ecosystems, or reset the dashboard clock.
