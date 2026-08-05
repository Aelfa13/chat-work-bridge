# Architecture

Engineering Bridge v0.2.0-alpha.3 is a local STDIO MCP server with four small layers:

1. `src/mcp-stdio.ts` loads trusted workspace configuration, registers four tools, and connects the MCP STDIO transport.
2. `RegisteredWorkspaceRegistry` maps fixed caller-visible IDs to absolute configured roots. MCP callers cannot register paths.
3. `RegisteredWorkspaceTaskService` assigns UUID task IDs and holds queued, running, completed, and failed task records in process memory.
4. `CodexExecutor` starts the local Codex CLI with fixed read-only arguments and parses its JSONL output. `ControlledPatchService` separately records patch metadata and uses fixed Git commands to validate and apply reviewed patches.

There is no HTTP server, UI, database, account system, background daemon, remote transport, or general command runner.

## Read-only task flow

`run_task` resolves a registered workspace, then starts Codex with approval `never`, a read-only sandbox, an ephemeral session, and network access disabled. Instructions go through standard input. `task_result` is the single public polling tool: it returns `ready: false` for queued or running records, completed output, or a safe error. Internal task states and status lookup remain in the service.

These executor parameters restrict writes performed by Codex, but Bridge does not create OS-level filesystem read containment. A same-user Codex process may read paths outside the workspace when the operating system permits it.

## Controlled patch flow

Controlled writes require a registration with `allow_write: true`. Generation verifies that the configured root resolves to the Git top-level, that tracked state is clean, and that HEAD exists. Codex remains read-only and returns a textual proposal.

Application requires exact `APPLY`, a completed proposal, the original HEAD, a clean tracked worktree and index, and a safe unified text patch. Targets may modify existing tracked regular files or add an ordinary text file using exact mode 100644 when that path is absent from base HEAD, the current index, and the worktree. Bridge then runs fixed `git apply --check` and `git apply` commands without a shell. It does not run tests, stage, commit, or push.

The prompt asks Codex for a narrow valid diff, but prompt compliance is not a security boundary. Patch validation is code-enforced; whether the proposed semantic change is desirable remains a human review decision.

## Lifetime and concurrency

Tasks, proposals, results, and diagnostic output are not persisted. Restarting Bridge discards them. Multiple tasks have independent UUIDs and records, but there is no queue service, cancellation, timeout, or restart recovery.
