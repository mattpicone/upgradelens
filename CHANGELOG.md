# Changelog

## 0.3.0 — 2026-08-30

Machine-only discovery, contract, and payment release.

- Added a canonical v0.3.0 catalog generating MCP tools, OpenAPI, pricing,
  Registry/Bazaar metadata, examples, and immutable version checks.
- Added shared MCP/REST execution gating with one HMAC-scoped rolling trial
  unit and exact x402 v2 USDC pricing ($0.01 / 10,000 atomic USDC).
- Added durable D1 business calls, trial entitlements, payment attempts/events,
  encrypted reconciliation state, integer-micros revenue ledger, and rollout
  attestations; mainnet remains fail-closed until owner credentials and a
  matching testnet attestation exist.
- Added unseeded buyer discovery harness, challenge-only payment probe,
  operator status checks, and a bounded one-minute reconciliation cron.

## 0.2.2 — 2026-08-30

Remote-client compatibility and install-path release.

- Enabled validated public web/Electron Origins and correct CORS preflight for the public read-only HTTPS MCP endpoint.
- Added current stateless MCP 2026-07-28 discovery, per-request metadata/header validation, complete-result envelopes, and structured unsupported-version negotiation while preserving 2025 clients.
- Added Copilot's root `.mcp.json`, refreshed all manifest versions, and documented verified Codex/Cursor/Claude/Gemini/Copilot install and listing status.
- Proved a real Codex install, tool discovery, and owner-tagged tool call against production without changing genuine-business counters.

## 0.2.1 — 2026-08-29

Release-note evidence precision fix.

- Made breaking-change extraction conservative: only explicit breaking/incompatibility sections and conventional `BREAKING CHANGE:` markers produce facts.
- Suppressed negated, reverted and reference-only mentions so release notes cannot create false breaking-change claims from narrative prose.
- Replaced each curated package's enrichment snapshot atomically, removing stale facts that the stricter extractor no longer accepts.
- Added focused extraction regression tests.

## 0.2.0 — 2026-08-28

Correctness and free-tier hardening release.

- Replaced npm version/range behavior with strict `node-semver` reference semantics and expanded PEP 440 handling for epochs, locals, post/dev releases, compatible releases, wildcards and malformed clauses.
- Made incomplete OSV, registry, mapped-EOL and runtime evidence produce `unknown`; preserved blockers for no-ops; added deliberate pre-1.0 npm and PyPI CalVer review behavior; fixed downgrade-range and epoch-aware target selection.
- Added `action_allowed`, claim-to-evidence links and explicit per-source coverage. Candidate discovery can no longer authorize an edit without a full pair check.
- Added MCP output schemas, read-only/idempotent annotations, Origin and protocol validation, bounded bodies, single-message semantics and tool-only telemetry.
- Added edge burst limiting, batch-unit charging, bounded key issuance and retention, fail-closed counters, global daily/cold-cache fuses, short outage caching, upstream response caps and lower batch concurrency.
- Blocked payment activation until verification, settlement, replay protection and entitlement lifecycle are implemented; replaced traffic-only triggers with retained-use, reliability, unknown-rate and paid-intent gates.
- Removed a redundant D1 index and widened deterministic release-note enrichment coverage to 30 recent releases.

## 0.1.0 — 2026-08-28

Initial public release.

- REST API v1: `/v1/upgrade/check`, `/v1/upgrade/plan`, `/v1/upgrade/target`, `/v1/upgrade/batch`, `/v1/package/{ecosystem}/{name}`, `/v1/evidence/{id}`, `/v1/keys`, `/healthz`, `/openapi.json`, `/llms.txt`, `/pricing.json`.
- Remote MCP server (streamable HTTP) at `/mcp` with three tools: `check_dependency_upgrade`, `find_safe_upgrade_target`, `plan_dependency_upgrade`.
- Deterministic analysis engine (no runtime LLM): OSV security delta, deps.dev version listing, registry per-version metadata, engines/requires_python runtime compatibility, direct dependency diff, yanked/deprecated/EOL detection, semver/PEP 440 classification, documented breaking-change facts.
- D1-backed pair cache, evidence store, usage telemetry with internal/external classification, rate limiting.
- Owner dashboard with encoded business-state thresholds.
- Scheduled GitHub Actions: CI+deploy, breaking-change enrichment, health monitor with automatic incident issues.
