# Workmate

Cross-platform local AI workspace (forked from EasyAI).

**Agent engine:** default in-process **pi**; optional **AgentScope Sidecar** via WebSocket JSON-RPC (`WORKMATE_AGENT_ENGINE=agentscope`).

Quick links:

- Runtime modes: `docs/runtime-modes.md`
- Release checklist: `docs/release-checklist.md`
- Dual-runtime release notes: `docs/dual-runtime-release-notes.md`
- Docker deployment: `deploy/docker/workmate/`
- AgentScope migration: `docs/agentscope-migration.md`
- AgentScope ABI: `docs/design/agentscope-abi.md`
- Concurrency runtime: `docs/design/concurrency-runtime.md`
- Concurrency verification checklist: `docs/design/concurrency-verification.md`
- Concurrency regression command: `pnpm concurrency:regression` (includes dsh MCP/Skills bridge case first)
- Standalone dsh MCP/Skills regression: `pnpm dsh:regression`

```bash
pnpm install
pnpm dev
pnpm web:build
pnpm web:start
pnpm workmate:doctor
pnpm workmate:init
pnpm workmate:start
pnpm agentscope:smoke
pnpm dsh:regression
pnpm concurrency:regression
```

Default local service port: `4328` (`workmate`). This is intentionally different from `opcai` / `easyai`, which still default to `4318`.

Install from npm:

```bash
npm install -g @next-open-ai/workmate
workmate doctor
workmate init
workmate start
```

Data directory: `~/.workmate`.
