# chat-work-bridge Project Rules

This file is the short project entry point. Read it before any task.

## Required entry

Before non-trivial work, read:

1. docs/operations/开发入口.md
2. the newest report under docs/status/
3. docs/operations/版本管理运行手册.md

For production work also read:

4. docs/operations/部署与灾备任务书.md
5. docs/operations/production-drift-allowlist.yml

## Current baseline

- Governance profile: continuous
- Existing Node.js/TypeScript local MCP STDIO package; Node.js 22+
- Build/test: `npm run build` and `npm test`
- GitHub CI/release exists in `.github/` and `RELEASE_NOTES.md`
- `main` is the pure upstream-sync baseline.
- `dev` contains governance and personal integration work.
- `feature/windows-chatgpt-desktop` is the planned Windows adaptation branch; it is not created yet.
- Default branch: main
- Development branch: dev
- Production-history branch: N/A
- origin: personal fork (`git@github.com:Aelfa13/chat-work-bridge.git`)
- upstream: source upstream (`git@github.com:wudy29/engineering-bridge.git`)
- Windows port baseline: supplemental, 331 total / 244 pass / 86 known platform failures / 1 skip / 0 unexplained failures.
- Windows baseline status: `ACCEPTED_WITH_KNOWN_PLATFORM_FAILURES`; upstream regression is `NOT_PROVEN`.
- Authoritative upstream CI: `ubuntu-latest`, Node.js 22, `npm test`; Windows is not in the upstream CI matrix.
- Production direct edit: forbidden for daily development
- Git write policy: MANUAL

## Boundaries

- Development is the default workspace.
- Validation is a development-test boundary, uses separate data/config/dependencies, is not a production copy, and follows manual start → test → manual stop.
- The Windows full-test result is a supplemental known baseline, not a requirement for 331/331 PASS before feature work.
- Windows port work must not add unexplained failures, must not increase known failures without an explanation, must add targeted Windows validation, and should reduce known failures over time.
- There is currently no real production runtime; production host/service/database/deployment path are not configured here.
- A recovery mirror is not configured.
- Secrets, tokens, private keys, production data, logs, caches, and build outputs do not enter Git by default.

## Failure behavior

When remote proof, authentication, validation, backup, or drift classification fails: stop, report the narrow blocker, and do not fallback, force, reset, clean, or deploy.

Detailed rules live in the linked documents; do not copy them here.
