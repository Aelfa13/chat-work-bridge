# Architecture

This document describes the Engineering Bridge V1 / 1.0.0 candidate behavior. It does not claim that a 1.0.0 tag, release, or publication exists.

Engineering Bridge is a local STDIO MCP server with five tools and four small layers:

1. `src/mcp-stdio.ts` loads trusted workspace configuration, registers `run_task`, `task_result`, `control_task`, `generate_controlled_patch`, and `apply_controlled_patch`, and connects the MCP STDIO transport.
2. `RegisteredWorkspaceRegistry` maps fixed caller-visible IDs to absolute configured roots. MCP callers cannot register paths.
3. `RegisteredWorkspaceTaskService` assigns UUID task IDs and holds task, supervisor-review, thread, output, error, and evidence state in process memory.
4. `CodexExecutor` starts the local `codex app-server --stdio` protocol with fixed read-only task settings. `ControlledPatchService` separately records proposal metadata and uses fixed Git commands to validate and apply reviewed patches.

There is no HTTP server, UI, database, account system, background daemon, remote transport, or general command runner. V1 does not implement alpha.4 project binding.

## Read-only supervised task flow

`run_task` is always read-only. It resolves a registered workspace and starts Codex with approval `never`, a read-only sandbox policy, and network access disabled. The executor starts native app-server threads with `thread/start`; after supervisor feedback it preserves the returned thread ID and uses `thread/resume`, followed by a new turn, so the conversation continues on the same Codex thread.

`task_result` reports `queued` or `running` with `ready: false`. A successful turn moves to `waiting_for_supervisor_review` with `ready: true` and `review_output`. The response also includes the bounded, process-local `evidence` collected from command-execution and file-change protocol items. Evidence is diagnostic task output, not authorization to write or proof that a requested semantic result is correct.

`control_task` supplies the supervisor transitions. `continue` requires a non-empty instruction while waiting for review and resumes the same thread for another read-only turn. `steer` requires a non-empty instruction while a turn is running and sends it to that turn. `interrupt` is valid only while running; an interrupted turn ends in `failed`, not in a resumable review state. `accept` is valid only while waiting for review and promotes the reviewed output to `completed` as `output`.

Task and supervisor state is process-local. There is no persistence, automatic timeout, restart recovery, or automatic acceptance. A server restart discards tasks, thread continuity, evidence, and outputs.

These executor parameters restrict writes performed by Codex, but Bridge does not create OS-level filesystem read containment. A same-user Codex process may read paths outside the workspace when the operating system permits it.

## Controlled patch flow

Controlled writes are a separate path and require a registration with `allow_write: true`. `generate_controlled_patch` verifies that the configured root resolves to the Git top-level, that tracked state and the index are clean, and that HEAD exists. It records the base HEAD and schedules Codex, still read-only, to produce a textual unified-diff proposal. Proposal and task records are process-local.

`apply_controlled_patch` requires confirmation equal to exact, case-sensitive `APPLY`, a known completed proposal that has not already been applied, the original HEAD, a clean tracked worktree and index, and a safe unified text patch. Targets may modify existing tracked regular files or add an ordinary text file using exact mode 100644 when that path is absent from base HEAD, the current index, and the worktree. Bridge then runs fixed `git apply --check` and `git apply` commands without a shell. It does not run tests, stage, commit, or push.

The generation prompt asks Codex for a narrow valid diff, but prompt compliance is not a security boundary. Patch validation is code-enforced; whether the proposed semantic change is desirable remains a human review decision.
