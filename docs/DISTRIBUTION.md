# Distribution status and playbook

Discovery is part of the product. This file tracks every surface, its status,
and exactly what remains.

## Status legend
- DONE — live
- READY — fully prepared, blocked only on a human-gated account action
- PARTIAL — a live URL exists on one surface; the requested directory page does not
- NOT INDEXED — listing or crawl not live; do not claim DONE
- DOCS ONLY — install copy exists; not a marketplace/directory listing
- LATER — intentionally deferred until usage signal exists

## Surfaces

| Surface | Status | Notes |
|---|---|---|
| GitHub public repo | DONE | https://github.com/mattpicone/upgradelens. Topics include `mcp`, `mcp-server`, `gemini-cli-extension`, and `agent-plugins`. Release `distribution-2026-08-29` exists from the existing tag |
| Official MCP Registry (registry.modelcontextprotocol.io) | DONE | Published as `io.github.mattpicone/upgradelens`; the v0.2.x manifest adds agent-safe action gating, output schemas and read-only/idempotent annotations. Republish via the `Publish to MCP Registry` GitHub Actions workflow (OIDC, no credentials needed) |
| Gemini CLI extension gallery | READY | Root `gemini-extension.json` and `GEMINI.md` are checked in; `gemini-cli-extension` topic is set; immutable `distribution-2026-08-29` tag and GitHub Release exist. Do not claim a live gallery listing until a gallery URL exists |
| Agent Plugins 1.0 | READY | Root `plugin.json` and `mcp.json` conform to the portable 1.0 layout and contain no credentials. The `agent-plugins` topic is set. Maintainer-directory submission remains review-gated |
| llms.txt + OpenAPI + pricing.json | DONE | Live at https://upgradelens.mattpicone.workers.dev (`/llms.txt`, `/openapi.json`, `/pricing.json`) |
| Worker discovery docs | DONE | Live on the Worker host: `/mcp.json`, `/server.json`, `/.well-known/mcp/server-card.json`, `/.well-known/mcp.json`. `/llms.txt` includes the when / do-not-use tool table |
| PulseMCP | NOT INDEXED | **Rejected / form closed** 2026-08-29. https://www.pulsemcp.com/submit still shows the mid-August pause: "submissions and changes are temporarily paused." Search `?q=upgradelens` returns 0 servers. One check, then stopped. No listing URL. Official-registry auto-index has not produced a listing |
| Glama MCP directory | PARTIAL | **Servers listing pending.** https://glama.ai/mcp/servers/mattpicone/upgradelens is 404. **Add Server** on https://glama.ai/mcp/servers opens a Sign Up modal (Google/GitHub); add/claim cannot finish without owner login. **Connector listing accepted** via official-registry ingest: https://glama.ai/mcp/connectors/io.github.mattpicone/upgradelens (unclaimed, status "Not tested"). Do not treat the servers directory as DONE |
| Smithery | LATER | Focused on hosted/stdio servers; add if remote listings show traction |
| Anthropic Connectors Directory | READY (human-gated) | Submission requires the account owner to accept terms. Draft below |
| OpenAI Apps SDK directory | LATER | Requires app packaging beyond an MCP tool server; revisit after usage signal |
| Cursor discovery | DOCS ONLY | README one-click `cursor.com/install-mcp` link, landing-page snippets, and `examples/cursor/.cursor/mcp.json`. Not a Cursor Marketplace listing. **Skipped 2026-08-29:** no free public add form — https://cursor.directory/mcp/new redirects to login `?next=/plugins/new` |
| x402 Bazaar / Agentic.Market | LATER | Only relevant after paid-intent gates are met and a verified payment implementation exists |
| npm/PyPI thin client packages | LATER | Only if genuine usage suggests installation friction |

## Anthropic Connectors Directory — prepared draft

- Name: UpgradeLens
- Endpoint: `https://upgradelens.mattpicone.workers.dev/mcp` (streamable HTTP, no auth for evaluation tier)
- Description: Dependency upgrade intelligence for coding agents. One deterministic, source-cited call answers whether and how an npm/PyPI package should move from version A to version B: OSV security delta, runtime compatibility, dependency diff, EOL, documented breaking changes.
- Categories: developer tools
- Auth: none (free tier) / API key optional
- Data handling: no user data stored; telemetry is anonymized (hashed identifiers); read-only service
- Submission page: https://docs.claude.com/en/docs/agents-and-tools/mcp-connectors (follow current submission link)

## Post-deploy checklist (automated where possible)

1. ~~Publish registry entry~~ DONE via `Publish to MCP Registry` workflow (2026-08-28).
2. ~~Prepare free discovery packages~~ DONE: Gemini extension, Agent Plugins 1.0 manifests, install docs, and immutable distribution tag.
3. Directory submissions (one each, 2026-08-29), after Worker discovery docs were live:
   - PulseMCP: **rejected / form closed**. Pause banner still up; 0 search hits. Stopped.
   - Glama: **pending** add/claim (Sign Up wall). Connector URL accepted (registry ingest): https://glama.ai/mcp/connectors/io.github.mattpicone/upgradelens. Servers path still 404.
   - cursor.directory: **skipped** — no free public add form (login-gated plugin submit only).
   Never claim DONE without a live listing URL. Do not resubmit unless a form reopens.
4. ~~Add `gemini-cli-extension` and `agent-plugins` GitHub topics~~ DONE 2026-08-29. Gallery/directory listing is still a separate crawl — do not claim DONE on those surfaces without a live URL.
5. Run three $0 discovery experiments one at a time: registry listing copy, ecosystem-specific GitHub examples, then directory submissions. Accept an experiment only if attributed successful tool calls include at least 3 independent clients and at least 1 returning client; ignore handshakes, scans, keys and owner traffic.
