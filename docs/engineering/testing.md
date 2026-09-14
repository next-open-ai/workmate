# 测试约定

> 场景级规格还可对照：[../sdd/test-spec.md](../sdd/test-spec.md)

## 1. 原则

- **每个模块**公共行为变更必须有可运行回归；禁止只交实现。
- 优先测 **契约、权限、路径隔离、状态机、并发**，而非供应商 SDK 内部。
- 已有脚本回归必须纳入相关 PR 的自检。

## 2. 分层

| 层级 | 范围 | 入口 |
|------|------|------|
| 静态 | 类型 / 构建 | `pnpm --filter @workmate/renderer typecheck`、各包 build |
| 单元 | 权限、路径、调度、纯函数 | 各包 `vitest` / `pnpm test` |
| 集成 | Fastify SSE、工具事件、存储 | 临时工作区 + mock Provider |
| 专项回归 | 并发运行时、dsh MCP/Skills | `pnpm concurrency:regression`、`pnpm dsh:regression` |
| E2E / 人工 | 桌面流式、审批、真模型 | 开发态 / 安装包 |

## 3. 模块落测约定

新增或大改下列包时，同步补测试（或扩展现有回归脚本）：

- `packages/orchestrator` — Plan/Run/审批/取消
- `packages/agent-core` — backend 选择、工具权限、工作区路径
- `packages/contracts` — schema 破坏性变更的兼容用例
- `apps/api` — orch 路由与 SSE
- `apps/gateway` — 适配器白名单与消息归一

## 4. 必测基线（摘要）

- [ ] 路径穿越（`../`、绝对路径、符号链接）被拒绝
- [ ] 只读权限无法写文件/跑脚本绕过审批
- [ ] 取消/失败不丢已成功产物与运行记录
- [ ] 并发任务工作区隔离、资产不互相覆盖
- [ ] 未配置模型时错误可读、UI/API 不崩溃

## 5. 命令

```bash
pnpm test
pnpm concurrency:regression
pnpm dsh:regression
```

发布前清单见 `docs/release-checklist.md`。
