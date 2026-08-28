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
| Official MCP Registry (registry.modelcontextprotocol.io) | READY | `server.json` prepared (`io.github.mattpicone/upgradelens`). After deploy: `mcp-publisher login github && mcp-publisher publish server.json` (automated in `scripts/first-deploy.sh`) |
| llms.txt + OpenAPI + pricing.json | DONE (in code) | Served at the public URL for crawler/agent ingestion |
| PulseMCP | READY | Auto-indexes the official registry; no separate submission needed once registry entry exists. Manual add form: https://www.pulsemcp.com/submit if indexing lags |
| Glama MCP directory | READY | Indexes official registry + GitHub topics (`mcp-server` topic set). Manual claim possible at https://glama.ai/mcp/servers after registry publish |
| Smithery | LATER | Focused on hosted/stdio servers; add if remote listings show traction |
| Anthropic Connectors Directory | READY (human-gated) | Submission requires the account owner to accept terms. Draft below |
| OpenAI Apps SDK directory | LATER | Requires app packaging beyond an MCP tool server; revisit after usage signal |
| Cursor discovery | DONE (in docs) | README + landing page carry copy-paste `mcp.json`; Cursor auto-invokes enabled MCP tools |
| x402 Bazaar / Agentic.Market | LATER | Only relevant once payments are activated (monetization trigger) |
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

1. Publish registry entry (`scripts/first-deploy.sh` does this).
2. Verify PulseMCP/Glama picked up the registry entry within ~1 week; if not, use their manual submit forms.
3. Add the MCP endpoint to the repo About link.
4. Announce nothing manually — machine legibility over marketing.
