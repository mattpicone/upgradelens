# Business-validation status

Updated 2026-08-29.

## Current conclusion

The engineering release and discovery packaging are complete, but the business
experiment has not reached its first confirmed organic business-tool call.
Business status must remain based only on the post-cutover `mcp_events` funnel:
external, non-verification, non-owned `tools/call` traffic for an exact
UpgradeLens tool whose handler ran and returned semantic success.

The last successful production health read still reported Worker version
`0.2.1` without the `telemetry_schema` field. That is the pre-cutover Worker;
no owner-tagged MCP verification was sent against it. The previously audited
production traffic was discovery/protocol-heavy (roughly 552 rows), with
registry/auth/security/health/crawler activity and zero confirmed organic
successful business-tool calls, zero genuine tool clients, and zero repeats.

## Completed locally

- `npm run typecheck` passes.
- `npm test` passes: 122 tests in 14 files.
- Real SQLite migration application passes for `0001` through `0004`.
- Three-pass MCP selection scorer passes: 30/30 labels and sequences per pass,
  18/18 positive cases, 0/12 negative UpgradeLens invocations, and no unsafe
  edits or unsupported ecosystems.
- `scripts/verify-production-mcp.mjs` is a guarded smoke test. It refuses to
  send any MCP traffic until `/healthz` reports `db=ok` and
  `telemetry_schema=ok`, then owner-tags `initialize`, `tools/list`, and all
  three `tools/call` tools and reads the owner dashboard.

## External gate

The deployment path is GitHub Actions (`.github/workflows/ci.yml`) and remains
independent of Cursor/Codex after deployment. Direct Wrangler deployment was
blocked in this session because the local OAuth session expired at
`2026-08-29T17:48:53.195Z`, no non-interactive `CLOUDFLARE_API_TOKEN` is
available locally, and the sandbox cannot resolve Cloudflare API/public Worker
DNS consistently. The CI workflow will deploy when its repository secret is
configured; it now verifies schema health and can run the guarded MCP smoke
test when the optional `OWNER_TOKEN` repository secret is also configured.

Do not classify the experiment as failed or successful until the production
health gate passes and the owner dashboard has been read after the cutover.
