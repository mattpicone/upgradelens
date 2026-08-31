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
| GitHub public repo | DONE | https://github.com/mattpicone/upgradelens. Topics include `mcp`, `mcp-server`, `gemini-cli-extension`, and `agent-plugins`. The repository contract is now v0.3.1 |
| Official MCP Registry (registry.modelcontextprotocol.io) | DONE | v0.3.0 was published and verified on 2026-08-31; v0.3.1 is the compatibility-preserving discovery-ranking patch with the same API and pricing contract |
| Codex CLI / desktop | DONE (direct install) | Personally executed `codex mcp add upgradelens --url https://upgradelens.mattpicone.workers.dev/mcp --bearer-token-env-var OWNER_TOKEN` with Codex `0.150.0-alpha.8`. `codex mcp list` showed enabled streamable HTTP/Bearer auth; an ephemeral read-only Codex task discovered and called `check_dependency_upgrade`, receiving `review_required`, `action_allowed=false`, confidence 0.95 and four evidence records. Owner auth kept the call internal |
| Claude Code | READY (direct install) | Current official command is `claude mcp add --transport http upgradelens https://upgradelens.mattpicone.workers.dev/mcp`. Claude CLI is not installed on this host. The Claude Connectors Directory has no UpgradeLens result; directory submission is account/review-gated at https://claude.ai/settings/plugins/submit |
| Gemini CLI extension gallery | NOT INDEXED | Root `gemini-extension.json` and `GEMINI.md` are checked in; gallery listing remains a separate crawl and is not claimed without a live card |
| GitHub Copilot Agent Plugins | READY (direct install) | Root `plugin.json` and new root `.mcp.json` match Copilot's Agent Plugin layout and contain no credentials; direct command is `copilot plugin install mattpicone/upgradelens`. Copilot CLI is not installed on this host. The portable `mcp.json` remains for other Agent Plugins clients |
| llms.txt + OpenAPI + pricing.json | DONE | Live at https://upgradelens.mattpicone.workers.dev (`/llms.txt`, `/openapi.json`, `/pricing.json`) |
| Worker discovery docs | DONE | Live on the Worker host: `/mcp.json`, `/server.json`, `/.well-known/mcp/server-card.json`, `/.well-known/mcp.json`. `/llms.txt` includes the when / do-not-use tool table |
| PulseMCP | NOT INDEXED | Re-verified 2026-08-30: https://www.pulsemcp.com/servers?q=upgradelens reports 0 servers and the submission pause banner remains. No resubmission attempted |
| Glama MCP directory | PARTIAL | Re-verified 2026-08-30: https://glama.ai/mcp/servers/mattpicone/upgradelens explicitly says it has no such server. The official-registry-ingested connector is live at https://glama.ai/mcp/connectors/io.github.mattpicone/upgradelens, unclaimed and "Not tested." Claim is gated by Glama sign-in; no duplicate submission attempted |
| Smithery | READY (human-gated) | Live search `https://smithery.ai/servers?q=upgradelens` has no exact UpgradeLens result. Publish → MCP redirects to Smithery account authentication (email, Google, or GitHub) before `/servers/new`; no submission was made |
| Anthropic Connectors Directory | READY (human-gated) | No UpgradeLens result on https://claude.com/connectors. Submission requires an authenticated owner/review flow. Draft below |
| OpenAI Apps SDK directory | LATER | Requires app packaging beyond an MCP tool server; revisit after usage signal |
| Cursor discovery | DOCS ONLY | Current Cursor supports project/global remote MCP JSON, Agent Plugins, and `cursor.com/install-mcp` / `cursor://` installers. README one-click install and `examples/cursor/.cursor/mcp.json` are ready. Live marketplace search on 2026-08-30 returned no UpgradeLens result; https://cursor.com/marketplace/publish shows "Sign in to apply." https://cursor.directory/plugins/upgradelens is 404 and submission is sign-in-gated. Cursor is not installed on this Codex host, so no Cursor client call was claimed |
| General web search | NOT INDEXED | Exact searches for `"UpgradeLens" MCP server` and `"UpgradeLens" "MCP"` did not surface the product/repo in general results on 2026-08-30. The official registry and direct GitHub URL remain the only useful discovery paths |
| x402 Bazaar / Agentic.Market | IMPLEMENTED / EXTERNAL INDEX PENDING | Paid MCP responses advertise Bazaar discovery metadata and exact $0.01 unit pricing. A public Bazaar result still requires an external settled payment and indexer crawl |
| npm/PyPI thin client packages | LATER | Only if genuine usage suggests installation friction |

## Anthropic Connectors Directory — prepared draft

- Name: UpgradeLens
- Endpoint: `https://upgradelens.mattpicone.workers.dev/mcp` (streamable HTTP, no auth for evaluation tier)
- Description: Dependency upgrade intelligence for coding agents. One deterministic, source-cited call answers whether and how an npm/PyPI package should move from version A to version B: OSV security delta, runtime compatibility, dependency diff, EOL, documented breaking changes.
- Categories: developer tools
- Auth: none for discovery and the rolling trial; x402 v2 USDC for additional units
- Data handling: no user data stored; telemetry is anonymized (hashed identifiers); read-only service
- Submission page: https://docs.claude.com/en/docs/agents-and-tools/mcp-connectors (follow current submission link)

## Post-deploy checklist (automated where possible)

1. ~~Publish and verify the immutable v0.3 release through the OIDC workflow~~ DONE for v0.3.0 on 2026-08-31; v0.3.1 repeats the same verified workflow for improved capability matching.
2. ~~Prepare free discovery packages~~ DONE: Gemini extension, Agent Plugins 1.0 manifests, install docs, and immutable distribution tag.
3. Directory submissions/checks (one each; re-verified 2026-08-30), after Worker discovery docs were live:
   - PulseMCP: **rejected / form closed**. Pause banner still up; 0 search hits. Stopped.
   - Glama: **pending** add/claim (Sign Up wall). Connector URL accepted (registry ingest): https://glama.ai/mcp/connectors/io.github.mattpicone/upgradelens. Servers path still 404.
   - Smithery: **not listed**; Publish → MCP requires account authentication.
   - Cursor Marketplace / cursor.directory: **not listed**; both submissions are login-gated.
   - Anthropic Connectors Directory: **not listed**; submission is owner/account/review-gated.
   Never claim DONE without a live listing URL. Do not resubmit unless a form reopens.
4. ~~Add `gemini-cli-extension` and `agent-plugins` GitHub topics~~ DONE 2026-08-29. Gallery/directory listing is still a separate crawl — do not claim DONE on those surfaces without a live URL.
5. ~~Prove one real client path~~ DONE 2026-08-30 with Codex install + discovery + owner-tagged tool call.
6. Run bounded discovery experiments one at a time. Accept an experiment only if attributed successful tool calls include independent external clients and a returning client; ignore handshakes, scans, legacy keys, testnet payments, and owner traffic.
