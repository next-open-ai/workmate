# 编码与设计标准

## 1. 总则

- 与现有 monorepo 风格一致；小步改动，禁止无关大重构。
- **可读、可测、可替换** 优先于炫技抽象。
- 密钥、Token、用户隐私不进日志与 Git。

## 2. TypeScript / 包

- 共享类型与 Zod schema 放 `@workmate/contracts`，不要在 app 内私自叉一份。
- 跨包 API 保持稳定；破坏性变更要有迁移说明与测试。
- `any` 仅在边界短暂使用并尽快收窄；公共导出必须有明确类型。

## 3. 进程与安全

- renderer：纯浏览器；网络只打本机 API / 受控 IPC。
- 工具执行：遵守员工权限档位与审批；工作区外写入默认拒绝。
- 主进程密钥：`safeStorage`；经 fork IPC 一次性下发，不落 domain.json。

## 4. Agent / 运行时

- 新执行后端实现 `ExecutionBackend`（或现行等价抽象），不要在 orchestrator 内嵌 SDK。
- AgentScope / dsh sidecar 变更同步设计文档与回归脚本。
- 流式事件字段与现有 SSE/ABI 对齐（见 `docs/design/agentscope-abi.md` 等）。

## 5. 文档

- 行为变更更新 `docs/design/` 或本目录工程约定。
- 注释只写非显而易见的约束（并发、续跑、权限）。

## 6. 禁止

- renderer 直接调模型 SDK 或写 domain KV。
- 多写者争用 `~/.workmate` 域数据。
- 提交密钥、大数据 runtime、本机绝对路径配置。
- 用文档代替测试。
