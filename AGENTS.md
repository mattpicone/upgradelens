# UpgradeLens — agent notes

Remote MCP (streamable HTTP, no key for the anonymous free quota):
`https://upgradelens.mattpicone.workers.dev/mcp`

Read-only. npm and PyPI only. Do not invent other ecosystems. Edit dependency
files only when a check returns `action_allowed: true`.

| Tool | Use when | Do not use when |
|---|---|---|
| `check_dependency_upgrade` | Current and target versions are already known and you need verified compatibility, OSV/CVE, EOL, and breaking-change evidence before editing | Installing a new package, searching docs, or the target version is still unknown |
| `find_safe_upgrade_target` | A dependency should move but the target version is not chosen yet — ranked candidates only, not a safety verdict | The target is already chosen, or as authorization to edit files |
| `plan_dependency_upgrade` | A target is selected and you need ordered, source-cited migration actions | General tutorials or choosing the target |

Typical sequence: if `current_version` is unknown, read the manifest first. If
the target is unknown, `find_safe_upgrade_target` then `check_dependency_upgrade`
(then `plan_dependency_upgrade` if the user wants migration steps).

A Cursor project config lives at `examples/cursor/.cursor/mcp.json`.
