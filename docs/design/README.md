# Workmate 设计文档索引（docs/design）

> 与实现同源维护。**当前权威架构**见 [architecture.md](architecture.md)；
> 通道网关各里程碑记录实现、验收与真机步骤。

## 文档列表

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [architecture.md](architecture.md) | 当前项目架构 / 进程与模块边界 / 主要逻辑（会话·滚动记忆·可续跑审批·**Plan/Run/ChangeSet 项目编排**·存储 keyring·通道） | ✅ 当前权威 |
| [execution-backend.md](execution-backend.md) | 多引擎统一抽象：`ExecutionBackend` 注册表（pi / agentscope / dsh） | ✅ 当前实现 |
| [dsh-sidecar.md](dsh-sidecar.md) | DeepSeek Harness 编码 Sidecar：JSON-RPC 桥、环境变量、事件映射 | ✅ Phase 1 |
| [agentscope-abi.md](agentscope-abi.md) | AgentScope Sidecar：WebSocket JSON-RPC ABI + AgentEvent 映射 | ✅ P0 |
| [concurrency-runtime.md](concurrency-runtime.md) | 多 session / 多用户 / dispatcher / sidecar 池 的并发执行机制、进程拓扑与隔离模型 | ✅ 当前实现 |
| [concurrency-verification.md](concurrency-verification.md) | 并发压测与验收清单：限流、优先级、sidecar 池、自愈、观测一致性 | ✅ 当前实现 |
| [project-orchestration.md](project-orchestration.md) | 项目 Plan/Run/ChangeSet 数据模型与调度约定（P0–P1） | ✅ |
| [gateway-m0.md](gateway-m0.md) | M0：编排层下沉、域存储单写者、可续跑 run、`/api/orch` REST/SSE 接口表 | ✅ |
| [gateway-m0-acceptance.md](gateway-m0-acceptance.md) | M0 验收清单（A–E）与各入口 | ✅ |
| [gateway-m1.md](gateway-m1.md) | M1：`@workmate/channel` 协议、网关子进程、Telegram 适配器与白名单；真机步骤 | ✅ |
| [gateway-m2.md](gateway-m2.md) | M2：远程办公门户与凭证链路(P1)、飞书(P2)、远程中继(P3)；人工步骤 | ✅ |

## 修订约定

1. 改变核心业务行为时，先改 `architecture.md` 对应小节，再在对应里程碑文档补记录；
2. 发布/验收门槛变化时同步更新相关「验收」表与 `README(.zh-CN).md` 的状态行；
3. 旧的早期文档（`docs/architecture/overview.md`、`docs/sdd/*`）保留为历史参考，与本文档冲突时以本文档为准。

## 验收脚本索引（无头/桩）

| 脚本 | 覆盖 |
| --- | --- |
| `scripts/headless-gateway-smoke.mjs` | 会话/审批续跑/项目并行（HTTP，echo/approval 两种 runner） |
| `scripts/remote-project-confirm.mjs` | 无 context 远程 confirm（服务端组装） |
| `scripts/remote-chat.mjs` | 无 context chat + 审批 allow 自动续跑 |
| `scripts/gateway-stub-smoke.mjs` | Telegram 通道链路：白名单拒绝 / 会话 / `/project start` |
| `scripts/gateway-feishu-smoke.mjs` | 飞书：解析/去重 + fake 通道会话 + 白名单 |
| `scripts/relay-smoke.mjs` | 远程中继：设备注册 + 终端 chat + 指令面 |
| `scripts/agentscope-smoke.mjs` | AgentScope Sidecar：hello/health/stub echo 事件流 |
