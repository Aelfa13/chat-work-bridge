# Contributing

Engineering Bridge is alpha software. Narrowly scoped fixes, documentation improvements, and tests are welcome when they preserve the current three-tool, read-only boundary: `run_task`, `task_status`, and `task_result` with local Codex execution over STDIO.

Keep changes focused and include tests when behavior changes. Do not add machine-specific paths, credentials, secrets, or private integration details to source, fixtures, examples, documentation, commits, or issue reports.

Run the standard checks before submitting a change:

```sh
npm install
npm run typecheck
npm run build
npm test
```

Describe what changed, why it is within the existing boundary, and which checks you ran. Security-sensitive reports should follow [SECURITY.md](SECURITY.md).
