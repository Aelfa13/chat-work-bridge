# Engineering Bridge v0.2.0-alpha.2

Engineering Bridge lets a compatible AI chat client ask the Codex CLI on your computer to inspect a registered code workspace. The chat client understands your request, Codex reads the code locally, and the Bridge connects them. Workspaces are read-only by default; an enabled write follows a review-first flow that generates a patch proposal and applies it only after exact `APPLY` confirmation.

This is alpha software for trusted local use. [简体中文](README.zh-CN.md)

## Why a bridge is needed

A normal web chat usually cannot see files on your computer or start your local Codex CLI. Engineering Bridge provides a local, pre-registered and scope-limited entry point. It does not make every ChatGPT or Claude conversation local-tool capable: the client must support launching a local STDIO MCP server.

## The four roles

- **ChatGPT, Claude, or another MCP client** understands your request, calls Bridge tools, and shows their results. Compatibility depends on support for locally configured STDIO MCP servers.
- **Engineering Bridge** maps a caller-visible workspace ID to a path configured by a trusted local operator, starts Codex with fixed read-only settings, tracks tasks in memory, and validates controlled patches.
- **Codex CLI** runs on your computer, reads the registered workspace, and returns analysis or a proposed Git diff. It must already be installed and authenticated.
- **MCP over STDIO** is the local protocol and process connection between the client and Bridge. The client starts Bridge and exchanges messages through standard input and output; there is no HTTP service.

## Who can use it

You can use this release when your AI client can configure and start a local STDIO MCP server, and your computer has Node.js, Git, and an authenticated Codex CLI. A browser-only chat that cannot configure local tools cannot use Engineering Bridge directly. Client configuration formats differ, so the generic fields below must be translated into the format documented by your client.

## What it can do today

- Read-only analysis: “Summarize the important files in this workspace without changing anything.”
- Code location: “Find where authentication is implemented and explain the flow.”
- Review: “Review the current code for reliability risks without editing files.”
- Controlled write: “Prepare a proposal that changes the timeout message in `src/client.ts`; show me the diff before applying it.”

For a controlled write, Bridge first returns a patch proposal and recorded base HEAD. Only exact `APPLY` can apply a validated proposal. You remain responsible for reviewing the whole diff and then running tests, staging, committing, and pushing if appropriate.

## Two modes

### Read-only: inspect without changing

Every registered workspace can run read-only tasks. Bridge launches Codex with a read-only sandbox, approval set to `never`, an ephemeral session, and network access disabled.

### Controlled write: show the change first

Controlled writes are off by default. They require `allow_write: true`, a clean Git worktree whose configured root is the repository top-level, and an existing HEAD commit. A proposal may modify only existing tracked regular text files. Bridge rejects additions, deletions, renames, copies, binary patches, mode changes, symlink changes, and unsafe patch paths.

Before applying, Bridge rechecks the repository root, HEAD, clean tracked state, and patch. It never automatically tests, stages, commits, or pushes.

## Before your first run

You need:

- Node.js 22 or newer;
- Git;
- an installed and authenticated `codex` CLI available on `PATH`;
- a local project directory;
- an MCP client that can start a local STDIO server;
- basic terminal familiarity.

For controlled writes, the project must additionally be a clean Git top-level with an initial commit, and its registration must explicitly contain `"allow_write": true`.

## Your first successful read-only run

1. Get the repository and enter it:

   ```sh
   git clone https://github.com/wudy29/engineering-bridge.git
   cd engineering-bridge
   ```

2. Install, check, and build:

   ```sh
   npm install
   npm run typecheck
   npm run build
   npm test
   ```

3. Create `workspaces.json` with an absolute, normalized project path:

   ```json
   [
     {
       "id": "my-project",
       "root": "/absolute/path/to/my-project"
     }
   ]
   ```

   The configuration is trusted local input. MCP callers select an ID but cannot register or replace paths. On macOS, `/tmp` aliases such as `/private/tmp` are compared by their real filesystem path for controlled-write Git-root checks.

4. Configure your MCP client to start the local server. The location and syntax of client configuration files differ; use your client's documentation. The generic fields are:

   ```json
   {
     "command": "node",
     "args": [
       "/absolute/path/to/engineering-bridge/dist/src/mcp-stdio.js",
       "/absolute/path/to/engineering-bridge/workspaces.json"
     ],
     "env": {
       "PATH": "/path/that/includes/node-and-codex"
     }
   }
   ```

   Use absolute paths. If the client already provides a suitable `PATH`, an `env` override may not be needed. Do not copy a configuration format into a client that uses a different schema.

5. Start or reconnect the client integration. Confirm that these five tools are visible:

   - `run_task`
   - `task_status`
   - `task_result`
   - `generate_controlled_patch`
   - `apply_controlled_patch`

6. Ask a first question:

   > In workspace `my-project`, list the top-level files and report the current Git HEAD if one exists. Do not modify anything.

7. A successful run returns a task ID, progresses through status polling, and produces an answer based on your project. Confirm no change with:

   ```sh
   git -C /absolute/path/to/my-project status --short
   ```

   For a clean Git project, no output means the worktree remains unchanged.

You may also start Bridge manually for protocol diagnostics:

```sh
node dist/src/mcp-stdio.js /absolute/path/to/workspaces.json
# or
npm run mcp:stdio -- /absolute/path/to/workspaces.json
```

The process waits for MCP messages on standard input; it is not an interactive shell and does not automatically connect itself to a chat client.

## Your first controlled write

1. Enable writes only for the intended Git workspace:

   ```json
   [
     {
       "id": "my-project",
       "root": "/absolute/path/to/my-project",
       "allow_write": true
     }
   ]
   ```

2. Make sure the configured root is the Git top-level and the tracked worktree and index are clean.
3. Ask the client to call `generate_controlled_patch` with the workspace ID and a narrow change request.
4. Wait for the proposal task to complete. Review every changed path, the complete diff, and the returned `base_head`. Nothing has been applied yet.
5. Reject or revise an unexpected proposal. If it is correct, call `apply_controlled_patch` with its `patch_task_id` and confirmation exactly equal to `APPLY`.
6. Inspect the result yourself:

   ```sh
   git -C /absolute/path/to/my-project status --short
   git -C /absolute/path/to/my-project diff --check
   git -C /absolute/path/to/my-project diff
   ```

7. Run the project's tests and decide whether to stage, commit, and push. Bridge does none of those operations.

## Current limits

- Running tasks cannot be cancelled and have no timeout.
- Tasks, proposals, results, and logs are not persisted across a Bridge restart.
- Read-only Codex execution does not provide OS-level filesystem read containment to the registered workspace. A same-user process may read other files that the OS permits.
- Bridge never automatically tests, stages, commits, or pushes.
- A human must review the complete proposal; a requested filename is not a code-enforced semantic allowlist.
- There is no HTTP service, UI, account system, caller authentication, or remote transport.

## More documentation

- [Architecture](docs/architecture.md)
- [Security design](docs/security.md)
- [Threat model](docs/threat-model.md)
- [Tool reference](docs/tools.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [Release notes](RELEASE_NOTES.md)
- [简体中文 README](README.zh-CN.md)

## Acknowledgements

Engineering Bridge was conceived and directed by wudy29 and developed in close collaboration with ChatGPT-Demu, with Codex assisting implementation and verification.
