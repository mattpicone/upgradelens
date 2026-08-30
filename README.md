# UpgradeLens

**Evidence-backed dependency upgrade intelligence for AI coding agents.**

Anonymous free evaluation quota — no signup and no API key required. Read-only.
npm and PyPI only.

One deterministic, source-cited call answers: *should this dependency move from
version A to version B, and what must be handled?*

- **Remote MCP:** `https://upgradelens.mattpicone.workers.dev/mcp` (streamable HTTP)
- **REST:** [`/openapi.json`](https://upgradelens.mattpicone.workers.dev/openapi.json) · [`/llms.txt`](https://upgradelens.mattpicone.workers.dev/llms.txt) · [`/pricing.json`](https://upgradelens.mattpicone.workers.dev/pricing.json)
- **Decisions:** `proceed | review_required | block | unknown` — `unknown` rather than fabricated certainty
- **Action gate:** edit dependency files only when `action_allowed` is `true`; target discovery always requires a follow-up check
- **Sources:** [deps.dev](https://deps.dev), [OSV.dev](https://osv.dev), [registry.npmjs.org](https://registry.npmjs.org), [pypi.org](https://pypi.org), [endoflife.date](https://endoflife.date). Every semantic claim carries evidence with a source URL and fetch timestamp.

## Install

### Cursor

[Add UpgradeLens to Cursor](https://cursor.com/install-mcp?name=upgradelens&config=eyJ1cmwiOiJodHRwczovL3VwZ3JhZGVsZW5zLm1hdHRwaWNvbmUud29ya2Vycy5kZXYvbWNwIn0=)
(official `cursor.com/install-mcp` installer; also works as
`cursor://anysphere.cursor-deeplink/mcp/install?name=upgradelens&config=eyJ1cmwiOiJodHRwczovL3VwZ3JhZGVsZW5zLm1hdHRwaWNvbmUud29ya2Vycy5kZXYvbWNwIn0=`).

Or add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "upgradelens": {
      "url": "https://upgradelens.mattpicone.workers.dev/mcp"
    }
  }
}
```

A checked-in example is at [`examples/cursor/.cursor/mcp.json`](examples/cursor/.cursor/mcp.json).
This is a docs/config install, not a Cursor Marketplace listing.

### Claude Code

```bash
claude mcp add --transport http upgradelens https://upgradelens.mattpicone.workers.dev/mcp
```

### Codex CLI

```bash
codex mcp add upgradelens --url https://upgradelens.mattpicone.workers.dev/mcp
```

Or configure it directly:

```toml
# ~/.codex/config.toml
[mcp_servers.upgradelens]
url = "https://upgradelens.mattpicone.workers.dev/mcp"
```

The CLI install path was verified end-to-end on 2026-08-30 with Codex
`0.150.0-alpha.8`: enabled connection, tool discovery, and a real
`check_dependency_upgrade` call. The verification used an environment-backed
owner Bearer token so it could not count as business demand; public evaluation
installs need no token.

### Gemini CLI

This repository includes `gemini-extension.json` and `GEMINI.md`:

```bash
gemini extensions install https://github.com/mattpicone/upgradelens
```

The Gemini extension gallery indexes public repos that have the
`gemini-cli-extension` GitHub topic. That topic is set on this repository;
gallery listing is a separate crawl and is not claimed here.

### GitHub Copilot Agent Plugins

```bash
copilot plugin install mattpicone/upgradelens
```

Portable Agent Plugins 1.0 `plugin.json` plus Copilot's root `.mcp.json` are
checked in and point at the remote HTTPS server. The existing `mcp.json` remains
for other Agent Plugins-compatible clients. No credential is embedded.
Maintainer-directory indexing is separate from these files.

### Microsoft APM

```bash
apm install --mcp io.github.mattpicone/upgradelens --transport http
```

### PydanticAI

```python
from pydantic_ai import Agent
from pydantic_ai.mcp import MCPServerStreamableHTTP

server = MCPServerStreamableHTTP("https://upgradelens.mattpicone.workers.dev/mcp")
agent = Agent("your-model", toolsets=[server])
```

### LangChain / LangGraph

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({
    "upgradelens": {
        "transport": "streamable_http",
        "url": "https://upgradelens.mattpicone.workers.dev/mcp",
    }
})
tools = await client.get_tools()
```

### Plain REST

```bash
curl -X POST https://upgradelens.mattpicone.workers.dev/v1/upgrade/check \
  -H 'content-type: application/json' \
  -d '{
    "ecosystem": "npm",
    "package": "express",
    "current_version": "4.19.2",
    "target_version": "5.1.0",
    "runtime": {"node": "20.11.0"}
  }'
```

Higher limits with an instant free key (`POST /v1/keys`). The evaluation quota
needs no key.

## MCP tools

| Tool | Use when | Do not use when |
|---|---|---|
| `check_dependency_upgrade` | You are about to change a package from a known current version to a known target version and need verified compatibility/vulnerability/EOL/breaking-change evidence before editing dependency files | Merely installing a package or searching docs |
| `find_safe_upgrade_target` | A dependency should be upgraded but the target version is not yet known — returns ranked candidates that must each be checked | The target version is already chosen, or as authorization to edit dependency files |
| `plan_dependency_upgrade` | A target is selected and you need ordered, source-cited migration actions | General tutorials |

Response (abbreviated):

```json
{
  "decision": "review_required",
  "action_allowed": false,
  "risk_score": 37,
  "latest_stable": "5.2.1",
  "security_delta": {
    "advisories_fixed_by_target": [{"id": "GHSA-qw6h-vgh9-j6wx", "aliases": ["CVE-2024-43796"]}]
  },
  "compatibility": {
    "runtime_supported": true,
    "dependency_changes": {"added": ["router"], "removed": ["depd"], "changed": []}
  },
  "reasons": ["Major version jump (4.19.2 -> 5.1.0).", "Upgrade fixes 1 known advisory: GHSA-qw6h-vgh9-j6wx."],
  "coverage": {"registry": {"status": "complete"}, "osv": {"status": "complete"}},
  "evidence": [{"id": "ev_...", "source_type": "osv", "source_url": "https://osv.dev/vulnerability/GHSA-qw6h-vgh9-j6wx", "fetched_at": "..."}],
  "confidence": 0.95,
  "freshness": "..."
}
```

## Why call this instead of doing it yourself?

An agent can combine deps.dev + OSV + registries + changelogs manually — this service exists to compress those 5–7 fetch/normalize/reconcile steps into one deterministic call with:

- **security delta** (advisories affecting current vs. fixed by / still affecting target — including "this target is itself affected, pick a newer one"),
- **runtime compatibility** (`engines.node` / `requires_python` evaluated against your runtime),
- **direct dependency diff** between the two versions,
- **yanked/deprecated/EOL flags**,
- **documented breaking changes** (deterministically extracted from official release notes, with URLs),
- **provenance for every claim**, cacheable and repeatable.

## Architecture

Cloudflare Worker (TypeScript/Hono) + D1 (SQLite). Version-pair analyses are cached by `(ecosystem, package, from, to, runtime, analysis_version)`. Breaking-change facts are precomputed by a scheduled GitHub Actions job using deterministic extraction from official release notes — no LLM calls at runtime, ever. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

## API stability

Versioned under `/v1`. Response schemas only gain fields; existing fields are not repurposed. `analysis_version` identifies scoring-logic revisions.

## License

MIT — see [LICENSE](LICENSE). Security policy: [SECURITY.md](SECURITY.md).
