# 架构与模块边界（工程摘要）

> 完整权威说明：[../design/architecture.md](../design/architecture.md)

## 1. 总原则

1. **编排在服务端，UI 只是客户端** — 会话/项目/审批/Run 属 `@workmate/orchestrator`。
2. **域数据单写者** — `~/.workmate/domain.json`（或 `WORKMATE_DATA_DIR`）仅 api 写。
3. **依赖单向** — 见下表；禁止 shortcut 跨层 import。

## 2. Monorepo 分层

```text
apps/renderer     → HTTP/SSE / IPC 仅客户端
apps/desktop      → 薄壳：窗口、密钥、fork api/gateway
apps/api          → Fastify + orchestrator 托管
apps/gateway      → IM / 中继适配（走 channel 协议）

packages/contracts     → Zod 契约（事实源）
packages/orchestrator  → 状态机 / 存储服务 / 可续跑
packages/agent-core    → 唯一允许调用模型 SDK 的层（pi / AS / dsh）
packages/tools         → 工具契约与风险标签
packages/channel       → 与传输解耦的通道协议
runtimes/*             → 可选 sidecar（如 agentscope-runtime）
```

### 依赖方向（强制）

```text
renderer ↛ Electron / Node / agent-core SDK
api → orchestrator → contracts / tools
api → agent-core（执行）
gateway → channel →（不直接碰 orchestrator 内核细节）
❌ orchestrator 不得依赖 Vue / Electron
❌ contracts 不得依赖业务实现包
```

## 3. 模块化与模式偏好

| 偏好 | 用法 |
|------|------|
| 契约优先 | 跨进程/跨包类型进 `contracts`，再生成/引用 |
| Adapter / Backend | `ExecutionBackend`（pi / AgentScope / dsh） |
| 状态机 | Plan / Run / 审批续跑在 orchestrator |
| 渐进 Skill | 元信息 → 读 SKILL.md → 隔离工作区 |

避免：在 renderer 做编排真相源；在多处复制工具权限判定。

## 4. 变更检查清单

- [ ] 新代码落在正确包；未引入反向依赖
- [ ] 契约变更同步 `@workmate/contracts` 与调用方
- [ ] 密钥未进入 domain KV 或日志
- [ ] 配套回归（见 [testing.md](./testing.md)）
