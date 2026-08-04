# Architecture

Engineering Bridge v0.2.0-alpha.1 is a local STDIO MCP server with four small layers:

1. `src/mcp-stdio.ts` loads trusted workspace configuration, registers five tools, and connects the MCP STDIO transport.
2. `RegisteredWorkspaceRegistry` maps fixed caller-visible IDs to absolute configured roots. MCP callers cannot register paths.
3. `RegisteredWorkspaceTaskService` assigns UUID task IDs and holds queued, running, completed, and failed task records in process memory.
4. `CodexExecutor` starts the local Codex CLI with fixed read-only arguments and parses its JSONL output. `ControlledPatchService` separately records patch metadata and uses fixed Git commands to validate and apply reviewed patches.

There is no HTTP server, UI, database, account system, background daemon, remote transport, or general command runner.

## Read-only task flow

`run_task` resolves a registered workspace, then starts Codex with approval `never`, a read-only sandbox, an ephemeral session, and network access disabled. Instructions go through standard input. Status and result tools read the in-memory task record.

These executor parameters restrict writes performed by Codex, but Bridge does not create OS-level filesystem read containment. A same-user Codex process may read paths outside the workspace when the operating system permits it.

## Controlled patch flow

Controlled writes require a registration with `allow_write: true`. Generation verifies that the configured root resolves to the Git top-level, that tracked state is clean, and that HEAD exists. Codex remains read-only and returns a textual proposal.

Application requires exact `APPLY`, a completed proposal, the original HEAD, clean tracked state, a safe unified patch, and targets that are existing tracked regular text files. Bridge then runs fixed `git apply --check` and `git apply` commands without a shell. It does not run tests, stage, commit, or push.

The prompt asks Codex for a narrow valid diff, but prompt compliance is not a security boundary. Patch validation is code-enforced; whether the proposed semantic change is desirable remains a human review decision.

## Lifetime and concurrency

Tasks, proposals, results, and diagnostic output are not persisted. Restarting Bridge discards them. Multiple tasks have independent UUIDs and records, but there is no queue service, cancellation, timeout, or restart recovery.
