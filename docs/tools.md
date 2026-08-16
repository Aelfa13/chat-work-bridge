# MCP tool reference

This is the tool surface of Engineering Bridge V1 (1.2.0). The local STDIO MCP server exposes nine tools.

## `run_task`

Inputs: `workspace_id`, `instruction`, optional `executor` (`"codex" | "dsh"`, default `codex`).

Starts a supervised task with the selected executor and returns `task_id`. `run_task` is always read-only: Codex uses approval `never`, a read-only sandbox policy, and disabled network access; DSH is pinned read-only per process. An unknown workspace becomes a failed task; it does not grant access to a new path. The executor selection is fixed for the task lifetime and reported honestly in `task_result`.

## `task_result`

Input: `task_id`.

Returns the task state, readiness, fixed `executor`, and current bounded `evidence`. Queued and running tasks have `ready: false`. A successful turn has state `waiting_for_supervisor_review`, `ready: true`, and `review_output`. After acceptance, state is `completed` and the reviewed text is returned as `output`. Failures return a safe `{code,message}` error. An unknown task ID returns `UNKNOWN_TASK`.

Conditional fields:

- `thread_id`: present only for Codex tasks once a real native app-server thread exists. DSH headless has no machine-resumable session seam, so DSH tasks never carry a fabricated `thread_id`.
- `partial_output`: present only when a genuine interrupt produced real partial output (for example, DSH cached partial stdout or the last completed Codex agent message). The task state is still `failed`; `partial_output` is never completed `output` and never appears in `error`.

`evidence` contains bounded command-execution and file-change items. When the existing bounds truncate or evict evidence, explicit markers are returned: strings cut by the size bound end with `[truncated]`, an oversized changes list gains a `[truncated: N additional changes omitted]` entry, and evidence evicted by the total count limit is reported through a synthetic `evidence-drop` item. These markers mean the diagnostic information is incomplete.

## `control_task`

Inputs: `task_id`, `action`, and optional `instruction`.

The actions are state-specific:

- `continue`: while `waiting_for_supervisor_review`, requires a non-empty instruction, queues another read-only turn, and preserves app-server thread continuity with `thread/resume` for Codex. For DSH, `continue` starts a new headless execution; there is no native resume.
- `steer`: while `running`, requires a non-empty instruction and steers the active turn (Codex only).
- `interrupt`: while `running`, interrupts the active turn. When interruption completes, the task ends as `failed`; genuine partial output may be exposed as `partial_output`.
- `accept`: while `waiting_for_supervisor_review`, marks the reviewed output `completed` without starting another turn.

Invalid actions for the current state return `INVALID_STATE_TRANSITION`. There is no automatic timeout, automatic acceptance, or persistent task supervision state.

## `bind_project`

Inputs: `project_path`, `confirmation` (must equal `BIND` exactly).

Registers an existing directory inside a configured `project_root` as a read-only managed workspace. The path must already exist, resolve inside an approved root (canonical real-path containment), and not already be registered. Returns the `workspace_id`; registration persists to `<config>.managed-workspaces.json`. A managed workspace does not gain controlled-write permission from binding.

## `create_project`

Inputs: `parent`, `name`, `confirmation` (must equal `CREATE` exactly).

Creates and git-initializes a new single-segment directory inside a configured `project_root` and registers it as a read-only managed workspace. Only `mkdir` and `git init` are performed; the repository is left unborn (no commit) and no files are added. Returns the `workspace_id`; registration persists to `<config>.managed-workspaces.json`.

## `authorize_workspace_write`

Inputs: `workspace_id`, `confirmation` (must equal `AUTHORIZE` exactly).

Grants persistent controlled-write permission to one managed workspace only; manual workspaces remain authoritative through `workspaces.json`. The authorization is persisted first, then applied at runtime. This permission gates only `apply_controlled_patch`; it is not direct-write access and does not change `run_task` (which stays read-only).

## `generate_controlled_patch`

Inputs: `workspace_id`, `change_request`.

Read-only proposal flow available in any registered workspace; no write authorization is required to generate. It verifies that the configured root resolves to the Git top-level and that tracked state and the index are clean (with an existing HEAD, or unborn-repository support for added-file proposals), records and returns `base_head`, and starts a separate read-only proposal task that does not modify files. The proposal and its applied history persist to `<config>.controlled-patches.json`.

## `refine_controlled_patch`

Inputs: `patch_task_id`, `change_request`.

Read-only refinement of a completed controlled-patch proposal: returns a new complete proposal against the same `base_head`, preserving the source proposal. Requires the source task to be `completed` and the workspace base to be unchanged. No write authorization is required; it never modifies files.

## `apply_controlled_patch`

Inputs: `patch_task_id`, `confirmation`.

The single controlled-write checkpoint. Confirmation must equal `APPLY` exactly, the proposal must be known, completed, and not already applied, and the workspace must hold controlled-write permission (managed `AUTHORIZE` or a manual `allow_write: true` entry). The tool rechecks the canonical Git root, clean tracked state and index, and exact base HEAD (including unborn-base validation) before validating and applying the patch once. It can modify existing tracked regular text files or add an absent ordinary text file from an exact 100644 text diff. A new target must be absent from base HEAD, the current index, and the worktree. It never tests, stages, commits, or pushes.
