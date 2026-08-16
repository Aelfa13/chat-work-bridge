# Contributing

Engineering Bridge is a stable local supervised bridge (V1; current release v1.2.0). Narrowly scoped fixes, documentation improvements, and tests are welcome when they preserve the current nine-tool MCP surface — `run_task`, `task_result`, `control_task`, `bind_project`, `create_project`, `authorize_workspace_write`, `generate_controlled_patch`, `refine_controlled_patch`, and `apply_controlled_patch` — and its supervision boundaries. Keep the tool surface minimal: a new tool must justify a real user capability need and a clear security boundary; the tool count is not fixed forever, but every addition must stay within the local supervised-bridge model and prefer the smallest sufficient change (YAGNI). Ordinary/supervisor execution (Codex and DSH) and proposal generation must remain read-only, with dangerous writes explicit and behind reviewed confirmation. Interactive turns use state-checked continue/steer/interrupt/accept, while completed patch proposals are polled through `task_result`, reviewed outside task state, and passed directly to `apply_controlled_patch` with exact `APPLY`; they must never enter supervisor review or be accepted through `control_task`. Controlled application must remain disabled by default, limited to existing tracked regular text files and absent 100644 ordinary text-file additions (including unborn repositories), and must never automatically run tests, stage, commit, or push. Active task/thread/evidence/review supervision state remains process-local with no automatic timeout, while the managed workspace catalog and controlled-patch retained state persist across restarts; `workspace_id` stays required, managed onboarding is confined to configured `project_root` approved roots through exact `BIND`/`CREATE`, and controlled-write authorization for managed workspaces goes through exact `AUTHORIZE`. Preserve backward compatibility for existing call shapes and defaults.

Keep changes focused and include tests when behavior changes. Do not add machine-specific paths, credentials, secrets, or private integration details to source, fixtures, examples, documentation, commits, or issue reports.

Run the standard checks before submitting a change:

```sh
npm install
npm run typecheck
npm run build
npm test
```

Describe what changed, why it is within the existing boundary, and which checks you ran. Security-sensitive reports should follow [SECURITY.md](SECURITY.md).
