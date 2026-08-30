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
- Default branch: main
- Development branch: dev
- Production-history branch: N/A
- origin: personal fork (`git@github.com:Aelfa13/chat-work-bridge.git`)
- upstream: source upstream (`git@github.com:wudy29/engineering-bridge.git`)
- Production direct edit: forbidden for daily development
- Git write policy: MANUAL

## Boundaries

- Development is the default workspace.
- Validation is a development-test boundary, uses separate data/config/dependencies, is not a production copy, and follows manual start → test → manual stop.
- There is currently no real production runtime; production host/service/database/deployment path are not configured here.
- A recovery mirror is not configured.
- Secrets, tokens, private keys, production data, logs, caches, and build outputs do not enter Git by default.

## Failure behavior

When remote proof, authentication, validation, backup, or drift classification fails: stop, report the narrow blocker, and do not fallback, force, reset, clean, or deploy.

Detailed rules live in the linked documents; do not copy them here.
