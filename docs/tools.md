# MCP tool reference

Engineering Bridge v0.2.0-alpha.2 exposes exactly five local STDIO MCP tools.

## `run_task`

Inputs: `workspace_id`, `instruction`. Starts a read-only Codex task and returns `task_id`. An unknown workspace becomes a failed task; it does not grant access to a new path.

## `task_status`

Input: `task_id`. Returns `queued`, `running`, `completed`, or `failed`. An unknown task ID returns `UNKNOWN_TASK`.

## `task_result`

Input: `task_id`. Returns `ready: false` while a task is active, completed output after success, or a safe serialized error after failure.

## `generate_controlled_patch`

Inputs: `workspace_id`, `change_request`. Requires a clean write-enabled Git top-level. Records and returns `base_head`, starts a read-only proposal task, and does not modify files. Poll it through the task tools and review the returned unified diff.

## `apply_controlled_patch`

Inputs: `patch_task_id`, `confirmation`. Confirmation must equal `APPLY` exactly. Rechecks repository and patch preconditions, then applies a valid reviewed patch once. It can modify existing tracked regular text files; it never tests, stages, commits, or pushes.

Tasks and proposals are process-local and are lost when the server stops.
