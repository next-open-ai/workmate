# AGENTS

给人类与各类 AI Agent 的仓库入口约定（通用，不依赖 Cursor 专有规则文件）。

## 必守红线

1. **回归测试**：新模块 / 公共行为变更必须带可运行回归；合入前至少跑相关包 `test`，涉及并发/dsh 时跑 `pnpm concurrency:regression` / `pnpm dsh:regression`。
2. **分层清晰**：renderer 不 import Electron/Node；**只有** `packages/agent-core` 可调用模型 SDK；编排状态在 `@workmate/orchestrator`（由 `apps/api` 托管）。
3. **强模块化**：契约以 `@workmate/contracts`（Zod）为单一事实源；通道协议与传输解耦（`@workmate/channel`）。
4. **域数据单写者**：domain KV 仅 api 进程写入；密钥在主进程 `safeStorage`，禁止写进 domain.json。
5. **小步可回滚**：改行为前先读权威架构文档；禁止无关大重构。

## 详规

| 文档 | 内容 |
|------|------|
| [docs/engineering/architecture.md](docs/engineering/architecture.md) | 分层与模块边界（工程摘要） |
| [docs/engineering/testing.md](docs/engineering/testing.md) | 回归 / 冒烟约定 |
| [docs/engineering/coding-standards.md](docs/engineering/coding-standards.md) | 编码标准 |
| [docs/engineering/README.md](docs/engineering/README.md) | 索引 |

权威详细架构仍以 [docs/design/architecture.md](docs/design/architecture.md) 为准；SDD 见 `docs/sdd/`。

## 常用命令（摘要）

```bash
pnpm install
pnpm test
pnpm concurrency:regression   # 含 dsh MCP/Skills 桥接
pnpm dsh:regression
```
