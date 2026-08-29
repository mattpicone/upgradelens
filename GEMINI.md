# UpgradeLens

Use UpgradeLens when a coding task is about changing an existing npm or PyPI dependency and the agent needs current, source-cited evidence.

- If both the installed version and intended target are known, call `check_dependency_upgrade` first for the go/no-go decision.
- If the target is not known, call `find_safe_upgrade_target`; its candidates are not safe claims, so check the chosen target before editing.
- If the user asks for migration, refactor, changelog, or test steps for a selected target, call `plan_dependency_upgrade`.
- Do not use these tools for a new installation, general package documentation, or unsupported ecosystems. The tools are read-only; edit files only when the returned `action_allowed` is true.
