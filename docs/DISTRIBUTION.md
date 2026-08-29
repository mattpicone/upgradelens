# Distribution status and playbook

Discovery is part of the product. This file tracks every surface, its status,
and exactly what remains.

## Status legend
- DONE — live
- READY — fully prepared, blocked only on deployment URL or a human-gated account action
- LATER — intentionally deferred until usage signal exists

## Surfaces

| Surface | Status | Notes |
|---|---|---|
| GitHub public repo | DONE | https://github.com/mattpicone/upgradelens with MCP topics for GitHub search discovery |
| Official MCP Registry (registry.modelcontextprotocol.io) | DONE | Published as `io.github.mattpicone/upgradelens`; the v0.2.x manifest adds agent-safe action gating, output schemas and read-only/idempotent annotations. Republish via the `Publish to MCP Registry` GitHub Actions workflow (OIDC, no credentials needed) |
| llms.txt + OpenAPI + pricing.json | DONE | Live at https://upgradelens.mattpicone.workers.dev (`/llms.txt`, `/openapi.json`, `/pricing.json`) |
| PulseMCP | READY | Auto-indexes the official registry; no separate submission needed once registry entry exists. Manual add form: https://www.pulsemcp.com/submit if indexing lags |
| Glama MCP directory | READY | Indexes official registry + GitHub topics (`mcp-server` topic set). Manual claim possible at https://glama.ai/mcp/servers after registry publish |
| Smithery | LATER | Focused on hosted/stdio servers; add if remote listings show traction |
| Anthropic Connectors Directory | READY (human-gated) | Submission requires the account owner to accept terms. Draft below |
| OpenAI Apps SDK directory | LATER | Requires app packaging beyond an MCP tool server; revisit after usage signal |
| Cursor discovery | DONE (in docs) | README + landing page carry copy-paste `mcp.json`; Cursor auto-invokes enabled MCP tools |
| x402 Bazaar / Agentic.Market | LATER | Only relevant after paid-intent gates are met and a verified payment implementation exists |
| npm/PyPI thin client packages | LATER | Only if genuine usage suggests installation friction |

## Anthropic Connectors Directory — prepared draft

- Name: UpgradeLens
- Endpoint: `<SERVICE_URL>/mcp` (streamable HTTP, no auth for evaluation tier)
- Description: Dependency upgrade intelligence for coding agents. One deterministic, source-cited call answers whether and how an npm/PyPI package should move from version A to version B: OSV security delta, runtime compatibility, dependency diff, EOL, documented breaking changes.
- Categories: developer tools
- Auth: none (free tier) / API key optional
- Data handling: no user data stored; telemetry is anonymized (hashed identifiers); read-only service
- Submission page: https://docs.claude.com/en/docs/agents-and-tools/mcp-connectors (follow current submission link)

## Post-deploy checklist (automated where possible)

1. ~~Publish registry entry~~ DONE via `Publish to MCP Registry` workflow (2026-08-28).
2. Verify PulseMCP/Glama picked up the registry entry within ~1 week; if not, use their manual submit forms.
3. Add the MCP endpoint to the repo About link.
4. Run three $0 discovery experiments one at a time: registry listing copy, ecosystem-specific GitHub examples, then directory submissions. Accept an experiment only if attributed successful tool calls include at least 3 independent clients and at least 1 returning client; ignore handshakes, scans, keys and owner traffic.
