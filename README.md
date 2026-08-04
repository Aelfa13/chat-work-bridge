# Engineering Bridge

Engineering Bridge 0.2.0-alpha is a small local STDIO MCP server. It sends an instruction to the locally installed Codex CLI in a configured workspace and returns Codex's final text to the MCP client. It can also apply a narrowly validated patch after explicit review and confirmation.

This is alpha software. Run it only on a machine you control, and have a trusted local operator maintain the workspace configuration.

[简体中文](README.zh-CN.md)

## In plain English

Engineering Bridge connects ChatGPT's Chat or Work entry point to the Codex CLI on your computer, replacing the need to copy prompts and answers by hand. Through Engineering Bridge, ChatGPT can give the local Codex CLI a task in a workspace that a trusted operator has already registered, check its progress, and bring the final answer back. Engineering Bridge also works with other apps that support local STDIO MCP tool calls.

## Before and after

Before: in Chat or Work, you describe the task; then you open the local Codex CLI, restate the task, wait, and bring the answer back to the conversation.

After: you describe the task once in Chat or Work. Engineering Bridge sends it to the local Codex CLI, checks its status, and brings the answer back to the current conversation.

## What you can ask today

The current bridge is useful for read-only questions such as:

- “Summarize the code changes in this workspace.”
- “Find where this behavior is implemented and explain it.”
- “Review this code for risks without changing anything.”

## One complete conversation

1. You ask in ChatGPT's Chat or Work entry point: “Where is login handled, and what should I know before changing it?”
2. ChatGPT sends the task through Engineering Bridge to the local Codex CLI for one registered workspace.
3. Engineering Bridge starts the local Codex CLI with read-only access.
4. ChatGPT checks the task status while Codex examines the workspace.
5. When the task finishes, ChatGPT retrieves Codex's final answer through Engineering Bridge and shows it to you.

## Current limits

Read-only tasks remain available in every registered workspace. Controlled writes are disabled by default and can only modify existing tracked regular text files in explicitly enabled Git workspaces. The bridge never automatically runs tests, stages, commits, or pushes changes.

There is no HTTP service, UI, or account system. Tasks and answers are not persisted, and running tasks cannot be cancelled and have no timeout.

## Requirements

- Node.js 22 or newer
- The Codex CLI installed, available as `codex`, and authenticated

## Install and check

```sh
npm install
npm run typecheck
npm run build
npm test
```

## Configure and start

Copy the example configuration and edit it:

```sh
cp config/workspaces.example.json workspaces.json
```

Each entry maps a caller-visible ID to a workspace root. `root` must be an absolute, normalized path (for example, `/home/alice/projects/example`, not a relative path or a path containing `..`). Optional `allow_write` defaults to `false`; set it to `true` only for a workspace where controlled patch application is intended. The file is trusted local configuration; MCP callers cannot register workspace roots.

After building, start the STDIO server with either command:

```sh
node dist/src/mcp-stdio.js /absolute/path/to/workspaces.json
# or
npm run mcp:stdio -- /absolute/path/to/workspaces.json
```

Connect that process to an MCP client as a local STDIO server. There is no HTTP or remote transport.

## Tools and task flow

The server exposes exactly five tools:

1. `run_task` accepts `workspace_id` and `instruction`, queues the work, and returns a `task_id`.
2. `task_status` accepts the `task_id`; poll it until the state is `completed` or `failed`.
3. `task_result` accepts the `task_id` and returns the final Codex text or a safe error after the task reaches a terminal state.
4. `generate_controlled_patch` accepts only `workspace_id` and `change_request`. For a write-enabled, clean Git worktree at its repository root, it records HEAD, starts the same read-only Codex executor, and returns `task_id` and `base_head`. Use `task_status` and `task_result` to poll and review the textual diff.
5. `apply_controlled_patch` accepts only that `patch_task_id` and exact confirmation `APPLY`. It rechecks the root, HEAD, and clean tracked state, validates the reviewed patch, and applies it once with fixed `git apply --check` and `git apply` calls.

Tasks and results exist only in process memory and disappear when the server restarts.

## Enforced execution boundary

For every task, the bridge launches local Codex with a fixed read-only sandbox, approval set to `never`, an ephemeral session, and network access disabled. It does not invoke a shell, and the child process receives only a small allowlist of inherited environment fields. The instruction is sent on standard input rather than placed in caller-controlled arguments.

The current implementation has no HTTP server, remote transport, database, persistence, UI, accounts, automatic tests, staging, commits, or pushes. Controlled patch generation verifies that an enabled root is exactly its Git top-level; ordinary read-only tasks do not require a Git repository. The bridge does not resolve real paths to enforce symlink containment. There is no task cancellation or timeout. See [SECURITY.md](SECURITY.md) before use.

## Acknowledgements
Engineering Bridge was conceived and directed by wudy29 and developed in close collaboration with ChatGPT-Demu, with Codex assisting implementation and verification.
Special thanks to Demu for helping turn an idea into a real open-source project—and for leaving a tangible trace in our shared world.
