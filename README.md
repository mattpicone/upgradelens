# UpgradeLens

**Evidence-backed dependency upgrade intelligence for AI coding agents.**

One deterministic, source-cited call answers: *should this dependency move from version A to version B, and what must be handled?* — instead of separately combining registry metadata, OSV vulnerability queries, dependency graphs, runtime constraints, EOL data, changelogs and release notes.

- **Ecosystems:** npm, PyPI
- **Remote MCP endpoint:** `https://upgradelens.mattpicone.workers.dev/mcp` (streamable HTTP)
- **REST API:** [`/openapi.json`](https://upgradelens.mattpicone.workers.dev/openapi.json) · [`/llms.txt`](https://upgradelens.mattpicone.workers.dev/llms.txt) · [`/pricing.json`](https://upgradelens.mattpicone.workers.dev/pricing.json)
- **Decisions:** `proceed | review_required | block | unknown` — `unknown` is returned rather than fabricated certainty
- **Action gate:** agents may edit dependency files only when `action_allowed` is `true`; target discovery always requires a follow-up check
- **Sources:** [deps.dev](https://deps.dev), [OSV.dev](https://osv.dev), [registry.npmjs.org](https://registry.npmjs.org), [pypi.org](https://pypi.org), [endoflife.date](https://endoflife.date). Every semantic claim carries evidence with a source URL and fetch timestamp.
- **Read-only:** the service never executes commands, never clones repos, never fetches caller-supplied URLs.
- **Free evaluation quota**, no signup. Higher limits with an instant free key (`POST /v1/keys`).

## MCP tools

| Tool | Use when | Do not use when |
|---|---|---|
| `check_dependency_upgrade` | You are about to change a package from a known current version to a known target version and need verified compatibility/vulnerability/EOL/breaking-change evidence before editing dependency files | Merely installing a package or searching docs |
| `find_safe_upgrade_target` | A dependency should be upgraded but the target version is not yet known — returns ranked candidates that must each be checked | The target version is already chosen, or as authorization to edit dependency files |
| `plan_dependency_upgrade` | A target is selected and you need ordered, source-cited migration actions | General tutorials |

## Setup

### Cursor

Add to `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "upgradelens": {
      "url": "https://upgradelens.mattpicone.workers.dev/mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http upgradelens https://upgradelens.mattpicone.workers.dev/mcp
```

### Codex CLI

```toml
# ~/.codex/config.toml
[mcp_servers.upgradelens]
url = "https://upgradelens.mattpicone.workers.dev/mcp"
```

### Gemini CLI

Install this repository as a Gemini CLI extension, or use the checked-in
`gemini-extension.json` manifest:

```bash
gemini extensions install https://github.com/mattpicone/upgradelens
```

The public extension is indexed from the `gemini-cli-extension` GitHub topic.

### Agent Plugins (Copilot and compatible clients)

This repository includes the portable Agent Plugins 1.0 `plugin.json` and
`mcp.json` manifests. Clients that support the format can install the
repository directly; no credential is embedded in the package.

### Microsoft APM

APM resolves the published MCP Registry entry:

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
