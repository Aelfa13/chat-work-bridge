# Engineering Bridge

Engineering Bridge 0.1.0-alpha is a small local STDIO MCP server. It sends an instruction to the locally installed Codex CLI in a configured workspace and returns Codex's final text to the MCP client.

This is alpha software. Run it only on a machine you control, and have a trusted local operator maintain the workspace configuration.

[简体中文](README.zh-CN.md)

## In plain English

Engineering Bridge replaces the manual copying of prompts and answers between a ChatGPT or MCP client and Codex on your computer. The client can give local Codex a task in a workspace that a trusted operator has already registered, check its progress, and bring the final answer back.

## Before and after

Before: you copy a question from the client, paste it into Codex, wait, and copy the answer back.

After: the client submits the same question through Engineering Bridge, checks whether it is finished, and retrieves the answer for you.

## What you can ask today

The current bridge is useful for read-only questions such as:

- “Summarize the code changes in this workspace.”
- “Find where this behavior is implemented and explain it.”
- “Review this code for risks without changing anything.”

## One complete conversation

1. You ask in your ChatGPT or MCP client: “Where is login handled, and what should I know before changing it?”
2. The client submits that task for one registered local workspace.
3. Engineering Bridge starts local Codex with read-only access.
4. The client checks the task status while Codex examines the workspace.
5. When the task finishes, the client retrieves Codex's final answer and shows it to you.

## Current limits

This version can inspect a registered workspace and return text, but it cannot write or edit files. It does not automatically commit or push changes.

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

Each entry maps a caller-visible ID to a workspace root. `root` must be an absolute, normalized path (for example, `/home/alice/projects/example`, not a relative path or a path containing `..`). The file is trusted local configuration; MCP callers cannot register workspace roots.

After building, start the STDIO server with either command:

```sh
node dist/src/mcp-stdio.js /absolute/path/to/workspaces.json
# or
npm run mcp:stdio -- /absolute/path/to/workspaces.json
```

Connect that process to an MCP client as a local STDIO server. There is no HTTP or remote transport.

## Tools and task flow

The server exposes exactly three tools:

1. `run_task` accepts `workspace_id` and `instruction`, queues the work, and returns a `task_id`.
2. `task_status` accepts the `task_id`; poll it until the state is `completed` or `failed`.
3. `task_result` accepts the `task_id` and returns the final Codex text or a safe error after the task reaches a terminal state.

Tasks and results exist only in process memory and disappear when the server restarts.

## Enforced execution boundary

For every task, the bridge launches local Codex with a fixed read-only sandbox, approval set to `never`, an ephemeral session, and network access disabled. It does not invoke a shell, and the child process receives only a small allowlist of inherited environment fields. The instruction is sent on standard input rather than placed in caller-controlled arguments.

The current implementation has no HTTP server, remote transport, database, persistence, UI, accounts, workspace writes, automatic commits, or pushes. It also does not verify that a configured root is a Git repository or resolve real paths to enforce symlink containment. There is no task cancellation or timeout. See [SECURITY.md](SECURITY.md) before use.

## Acknowledgements
Engineering Bridge was conceived and directed by wudy29 and developed in close collaboration with ChatGPT-Demu, with Codex assisting implementation and verification.
Special thanks to Demu for helping turn an idea into a real open-source project—and for leaving a tangible trace in our shared world.
