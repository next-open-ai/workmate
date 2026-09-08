# Workmate

**Workmate —— 跨平台、本地优先的「数字员工」AI 工作台**

> **语言：** 中文 (zh-CN) · [English](README.md)
>
> 采用「根 README 索引 + 语言分档」结构，本文件为中文全文。

---

Workmate 是一套桌面级 Agent 工作台：其中的“数字员工”可以对话、运行**项目编排**、使用 **Skills**、检索**知识库 / MCP 连接 / 联网搜索**、管理**资产与自动化**，并且能通过**本地通道网关**被外部 IM（Telegram / 飞书）乃至**远程中继终端**调度。与常见“聊天壳 + 状态都在前端”的 Agent 应用不同，Workmate 把重编排放进**服务端状态机**：桌面 UI、网关进程与未来的远程终端共享同一份会话、审批、运行、资产与项目状态。

仓库刻意保持 Electron 壳“薄”：

```text
Electron shell  →  本地 Fastify API  →  agent-core（pi / AgentScope / dsh）→ providers
Vue renderer ────── HTTP / SSE ────────┘
通道网关 ───────── HTTP / SSE ──────────┘（Telegram / 飞书 / 远程中继）
```

AgentScope 迁移说明见 `docs/agentscope-migration.md`；协议 ABI 见 `docs/design/agentscope-abi.md`。
并发执行机制说明见 `docs/design/concurrency-runtime.md`；压测与验收清单见 `docs/design/concurrency-verification.md`。
可重复执行的并发回归入口为 `pnpm concurrency:regression`（会先跑 dsh MCP/Skills 桥接 case）。独立验证：`pnpm dsh:regression`。

快速入口：

- 运行形态说明：`docs/runtime-modes.md`
- 发布前检查清单：`docs/release-checklist.md`
- 双运行形态改造说明：`docs/dual-runtime-release-notes.md`

## 能力一览

| 能力 | 说明 |
| --- | --- |
| 数字员工 | 职责与授权载体：可配模型、Skills、运行时偏好与权限档位（read-only/default/extended/full） |
| 执行后端 | 统一 `ExecutionBackend` 抽象，内置 `pi`，可选 `AgentScope` sidecar 池与 `dsh` 编码 sidecar |
| Skill（渐进加载） | 先授权元信息 → 按需读 `SKILL.md` → 才可在隔离运行工作区访问资源/执行脚本 |
| 项目编排 | 目标 → **Plan vN**（DAG）→ 确认 → **Run**；补充指令走 **ChangeSet** 增量失效下游；成员变更升 Plan 并尽量保留已完成节点 |
| 可续跑审批 | 工具审批把运行停在 `waiting-approval`；决议后自动以同 turn 新 attempt 续跑 |
| 会话滚动记忆 | 本会话 `memory.summary` + 水位线；超预算自动摘要，切换会话 flush；消息全文仍是真相 |
| 项目双工作区 | 过程产物在员工 run 空间；最终交付经 `publish_to_project` 晋升到项目目录并显示在文件树 |
| 知识库 / MCP / 搜索 | 本地 LanceDB + 云端知识库、MCP(http/sse/stdio)、多搜索商（含敏感词脱敏与降级） |
| 通道与远程办公 | 独立网关子进程：Telegram/飞书适配器 + 个人白名单；远程中继设备出连(WS)供终端调度 |
| 本地 embedding sidecar | 实验性本地 embedding runtime / proxy：已具备桌面管理、状态、provider 注册脚手架与设计文档 |
| 本地优先存储 | 域数据单一写者（api 进程）；密钥在主进程 `safeStorage` 加密、仅经 fork IPC 一次性下发 |
| 「远程办公/连接」门户 | P1 视图：管理 Telegram/飞书凭证、白名单、默认员工与网关状态/重启 |

## 仓库结构（pnpm monorepo）

| 路径 | 职责 |
| --- | --- |
| `apps/desktop` | Electron 主进程（薄）：IPC、sql.js 密钥/资产、fork api 与 gateway |
| `apps/renderer` | 纯浏览器 Vue 3（Vite+Tailwind）；只走 HTTP/SSE 与 IPC |
| `apps/api` | localhost Fastify 服务，托管编排层（`/api/orch/**`）与域 KV 单写者 |
| `apps/gateway` | 通道网关子进程：Telegram/飞书/中继适配器、白名单 |
| `packages/contracts` | 共享 Zod 契约（单一事实源） |
| `packages/agent-core` | 模型执行层与运行时适配层；唯一允许调用模型 SDK 的层 |
| `packages/tools` | 工具契约 + 风险标签 |
| `packages/orchestrator` | 服务端会话/项目状态机、存储服务、可续跑 run |
| `packages/channel` | 与传输解耦的通道协议（`UnifiedMessage/IChannel/registry/StreamSink`） |
| `packages/storage`、`packages/ui-kit` | 预留占位 |

当前完整架构与模块职责见 [docs/design/architecture.md](docs/design/architecture.md)。

## 快速开始

要求：Node.js ≥ 22、pnpm ≥ 10（`packageManager` 已固定）。  
如需 AgentScope sidecar，还需要 Python ≥ 3.10。

```bash
pnpm install
pnpm dev        # 桌面开发：先构建 workspace 包，再起 Vite + Electron
pnpm typecheck
pnpm build
pnpm package    # electron-builder 打安装包
```

如需启动独立 Web 运行时或 npm 形态：

```bash
pnpm web:build
pnpm web:start
```

如果通过 npm 安装发布包，可使用：

```bash
npm install -g @next-open-ai/workmate
workmate doctor
workmate init
workmate start
```

本地常用校验命令：

```bash
pnpm dsh:regression
pnpm concurrency:regression
pnpm agentscope:smoke
```

默认本地服务端口为 `4328`（`workmate`），刻意与 `opcai` / `easyai` 的默认 `4318` 区分，避免并行开发时端口冲突。
默认数据目录为 `~/.workmate`。

在“设置 → 模型”配置 Provider 之前不会存储/使用任何模型密钥。无头/CI 冒烟脚本见 `scripts/*-smoke.mjs` 与设计文档。

## 运行形态

Workmate 当前有 4 种实际运行形态：

| 运行形态 | 入口 | 支持级别 | 说明 |
| --- | --- | --- | --- |
| Desktop | `pnpm dev` / 安装包 | 完整 | 参考形态：Electron IPC、`safeStorage`、原生文件操作、桌面托管 gateway |
| Web launcher | `pnpm web:build && pnpm web:start` | 已支持 | 由本地 Fastify API 托管构建后的前端，不含 Electron 专属能力 |
| npm / CLI | `workmate start` | 已支持 | 与 web launcher 是同一运行时形态 |
| Docker | `deploy/docker/workmate/` | 支持构建 / 部署方案 | 已提供 Docker 构建与部署文档，能力对齐仍在演进 |

完整能力对齐矩阵见 [docs/runtime-modes.md](docs/runtime-modes.md)。

## 架构现实

如果你要基于当前仓库做评估，这几个事实最关键：

- 编排层是服务端唯一真相源：`/api/orch/**` + SSE 才是会话 / run / 项目的正式接口面。
- Electron 主进程刻意保持“薄”，不直接发模型请求。
- 模型 / 搜索 / 通道等密钥仍保留在主进程 `safeStorage`，不会写入 `domain.json`。
- 默认执行引擎是 `pi`；`AgentScope` 与 `dsh` 是挂在统一产品面下的可选执行后端。
- 本地 embedding sidecar 仍处于演进中：当前已有架构方案、provider 契约、状态管理与桌面控制面，但真正内嵌本地推理后端仍在产品化。

相关设计入口：

- [docs/design/execution-backend.md](docs/design/execution-backend.md)
- [docs/design/dsh-sidecar.md](docs/design/dsh-sidecar.md)
- [docs/design/agentscope-abi.md](docs/design/agentscope-abi.md)
- [docs/design/embedding-local-sidecar-architecture.md](docs/design/embedding-local-sidecar-architecture.md)
- [docs/design/embedding-local-sidecar-implementation-plan.md](docs/design/embedding-local-sidecar-implementation-plan.md)

## 发布

推送形如 `v0.1.0` 的 SemVer tag 会触发桌面发布工作流。

当前 CI 实际产出：

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| macOS | Apple Silicon (arm64) | `.dmg` |
| Windows | x64 | NSIS `.exe` |

Intel macOS 与 Linux 打包暂在 CI 停用（细节见 `.github/workflows/release.yml` 注释）。

## 文档导航

| 语言/主题 | 入口 |
| --- | --- |
| 运行形态 | [runtime-modes](docs/runtime-modes.md) |
| 架构与模块 | [docs/design/architecture.md](docs/design/architecture.md)（当前权威） |
| 设计文档索引与状态 | [docs/design/README.md](docs/design/README.md) |
| 执行后端抽象 | [docs/design/execution-backend.md](docs/design/execution-backend.md) |
| 并发机制与进程拓扑 | [docs/design/concurrency-runtime.md](docs/design/concurrency-runtime.md) |
| 并发压测与验收 | [docs/design/concurrency-verification.md](docs/design/concurrency-verification.md) |
| 通道网关里程碑 | [M0](docs/design/gateway-m0.md) · [M0 验收清单](docs/design/gateway-m0-acceptance.md) · [M1](docs/design/gateway-m1.md) · [M2](docs/design/gateway-m2.md) |
| 需求/架构/测试规格（早期） | `docs/sdd/*` |

## 通道网关里程碑状态

| 里程碑 | 状态 |
| --- | --- |
| M0 编排层 | ✅ 会话/项目状态机、域存储服务、可续跑审批、`/api/orch` REST+SSE |
| M1 网关 + Telegram | ✅ `@workmate/channel` 协议、`apps/gateway`、Telegram 适配器 + 白名单；桩验收 ALL PASS |
| M2 门户 + 飞书 + 远程中继 | ✅ P1 门户与凭证链路(IPC+safeStorage)、P2 飞书适配器、P3 最小远程中继；桩验收 ALL PASS |

## 许可

仓库尚未声明公开 LICENSE（内部项目），正式开源前请由所有者补充。
