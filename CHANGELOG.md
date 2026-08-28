# Changelog

## 0.1.0 — 2026-08-28

Initial public release.

- REST API v1: `/v1/upgrade/check`, `/v1/upgrade/plan`, `/v1/upgrade/target`, `/v1/upgrade/batch`, `/v1/package/{ecosystem}/{name}`, `/v1/evidence/{id}`, `/v1/keys`, `/healthz`, `/openapi.json`, `/llms.txt`, `/pricing.json`.
- Remote MCP server (streamable HTTP) at `/mcp` with three tools: `check_dependency_upgrade`, `find_safe_upgrade_target`, `plan_dependency_upgrade`.
- Deterministic analysis engine (no runtime LLM): OSV security delta, deps.dev version listing, registry per-version metadata, engines/requires_python runtime compatibility, direct dependency diff, yanked/deprecated/EOL detection, semver/PEP 440 classification, documented breaking-change facts.
- D1-backed pair cache, evidence store, usage telemetry with internal/external classification, rate limiting.
- Owner dashboard with encoded business-state thresholds.
- Scheduled GitHub Actions: CI+deploy, breaking-change enrichment, health monitor with automatic incident issues.
