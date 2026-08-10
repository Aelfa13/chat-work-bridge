# Contributing

Engineering Bridge V1 / 1.0.0 candidate is Alpha software. Narrowly scoped fixes, documentation improvements, and tests are welcome when they preserve the five-tool boundary: `run_task`, `task_result`, interactive-only `control_task`, `generate_controlled_patch`, and `apply_controlled_patch`. Ordinary/supervisor Codex execution and legacy-path proposal generation must remain read-only. Interactive turns use state-checked continue/steer/interrupt/accept, while completed patch proposals are polled through `task_result`, reviewed outside task state, and passed directly to `apply_controlled_patch` with exact `APPLY`; they must never enter supervisor review or be accepted through `control_task`. Controlled application must remain disabled by default, limited to existing tracked regular text files and absent 100644 ordinary text-file additions, and must never automatically run tests, stage, commit, or push. Preserve process-local state with no restart recovery or automatic timeout, and keep `workspace_id` required until project binding is implemented.

Keep changes focused and include tests when behavior changes. Do not add machine-specific paths, credentials, secrets, or private integration details to source, fixtures, examples, documentation, commits, or issue reports.

Run the standard checks before submitting a change:

```sh
npm install
npm run typecheck
npm run build
npm test
```

Describe what changed, why it is within the existing boundary, and which checks you ran. Security-sensitive reports should follow [SECURITY.md](SECURITY.md).
