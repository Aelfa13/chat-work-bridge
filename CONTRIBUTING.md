# Contributing

Engineering Bridge is alpha software. Narrowly scoped fixes, documentation improvements, and tests are welcome when they preserve the four-tool boundary: `run_task`, polling through `task_result`, and the explicit generate/review/apply controlled-patch flow. Codex execution must remain read-only; controlled application must remain disabled by default, limited to existing tracked regular text files and absent 100644 ordinary text-file additions, and must never automatically run tests, stage, commit, or push.

Keep changes focused and include tests when behavior changes. Do not add machine-specific paths, credentials, secrets, or private integration details to source, fixtures, examples, documentation, commits, or issue reports.

Run the standard checks before submitting a change:

```sh
npm install
npm run typecheck
npm run build
npm test
```

Describe what changed, why it is within the existing boundary, and which checks you ran. Security-sensitive reports should follow [SECURITY.md](SECURITY.md).
