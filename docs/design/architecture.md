# Workmate 项目架构、模块与主要逻辑（当前权威）

> 状态：随实现演进维护；与 `README(.zh-CN)`、`docs/design/gateway-m*.md` 保持一致。
> 目标读者：新成员快速建立全局观、评审人核对模块边界与数据流。

## 1. 产品定位与总览

Workmate 是**本地优先的数字员工工作台**：不是单一聊天工具，而是把「对话 / 项目编排 / Skills / 知识库 / 自动化 / 资产」组织在**数字员工**职责之下，并通过**本地通道网关**让外部 IM（Telegram/飞书）与**远程中继终端**也能调度同一套能力。

工程上最重要的三个约定：

1. **编排在服务端，UI 只是客户端**：会话、运行、审批、项目状态机都归 `@workmate/orchestrator` 所有（由 `apps/api` 进程托管），桌面渲染层与未来终端走同一组 `/api/orch` REST/SSE；
2. **域数据单写者**：domain KV 只由 api 进程写入（`~/.workmate/domain.json`）；Electron 主进程仅保留密钥与资产元数据；
3. **分层依赖单向**：renderer 不 import Electron/Node；只有 `packages/agent-core` 能调用 Vercel AI SDK；通道协议层（`@workmate/channel`）与传输实现解耦。

```text
┌────────────────────────── Electron 桌面（本地） ──────────────────────────┐
│                                                                          │
│  Vue Renderer (apps/renderer) ────────┐                                   │
│      ├─ Chat / Employees / Skills / Knowledge / Assets / Automations     │
│      └─ 远程办公·连接门户 (P1)         │  HTTP/SSE(/api/orch)             │
│                                       ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐           │
│  │ apps/api（Fastify，端口 4328，localhost）                     │           │
│  │   ├─ /api/chat        (旧 stateless 流式，兼容)               │           │
│  │   ├─ /api/orch/**     (REST + SSE)                           │           │
│  │   └─ @workmate/orchestrator   ← 编排层（唯一运行层）              │           │
│  └───────────────────────────────▲──────────────────────────────┘           │
│                                  │ /api/orch                                │
│  apps/gateway ── fork 拉起 ──────┘    @workmate/channel 协议                   │
│     Telegram 适配器 / 飞书适配器 / RelayDeviceClient(远程中继出连)             │
└────────────────────────────────────────────────────────────────────────────┘
```

## 2. 进程模型

| 进程 | 职责 | 生命周期 |
| --- | --- | --- |
| Electron Main | 窗口、IPC、sql.js（资产 + `safeStorage` 密钥）、**fork** api 与 gateway | 用户启停 |
| `apps/api`（子进程） | Fastify 服务 + orchestrator；持有 domain KV 单写者 | 由 Main fork，随桌面启停 |
| `apps/gateway`（子进程） | 通道入站/出站、白名单、把线程映射为 `/api/orch` 会话 | `channels.v1` 有启用通道时由 Main fork；可 `gateway-restart` |
| Renderer | 浏览器内 Vue | 窗口内 |

密钥通道：api 启动后与 gateway 启动后各自向 Main 发起 fork IPC 一次性索取解密快照（模型/搜索配置、通道 token），仅存内存。

## 3. 模块与边界（apps）

| 模块 | 关键职责 | 边界/约定 |
| --- | --- | --- |
| `apps/desktop/src/main/index.cjs` | 窗口与 IPC；sql.js：`app_kv`(密钥/资产)、`settings.channels.v1`(加密凭证)、资产文件；`storage-get/set` 转发 `/api/orch/kv`；fork 管理 api/gateway；域迁移 | 不执行模型调用 |
| `apps/renderer` | 全部 UI；组合式 store（无 Pinia）；`services/api.ts`（旧流式 chat）与 `services/orchestration.ts`（/api/orch 客户端 + SSE） | 无 Node/Electron import |
| `apps/api` | HTTP 编排接口 + 域 KV 代理 + SSE 事件流 | 只 bind 127.0.0.1 |
| `apps/gateway` | 通道运行时：`GatewayRuntime`(会话映射/指令面/审批/项目)、适配器(telegram/feishu)、relay 设备链接、配置(KV 或文件) | 凭证不自持（向 Main 索取或显式文件，用于桩/CI） |

### 渲染层「远程办公/连接」门户（P1）
侧栏新增 `remote` 视图：Telegram/飞书凭证卡片、白名单文本、默认员工、网关状态徽标与重启按钮；主进程提供 `get/save-channel-settings`、`gateway-status`、`gateway-restart` IPC。用户/身份体系未实现（按要求暂不建），白名单为字符串列表、默认拒绝。

## 4. 模块与边界（packages）

| 包 | 职责 | 说明 |
| --- | --- | --- |
| `contracts` | Zod 契约与 `AgentEvent` 事件并集 | 单一事实源 |
| `agent-core` | 唯一模型执行层：`ExecutionBackend` 注册表 + `streamAgentReply`（默认 **pi**，可选 **AgentScope** / **dsh** sidecar）、provider 适配、step 压缩、`summarizeSessionMemory`、Skill/MCP | 不感知会话持久化 |
| `tools` | `OpcaiTool{id,risk,inputSchema,execute}` + `ToolPolicy` | 契约层 |
| `orchestrator` | **编排核心**（见 §5）：含 **Session Rolling Memory** | 纯 Node，测试友好（runner 可注入） |
| `channel` | 通道协议与核心 | 传输无关 |
| `storage` / `ui-kit` | 占位 | 待接入 |

## 5. `@workmate/orchestrator` 主要逻辑（M0 核心）

文件构成：

- `storage/{kv,memory,json-file}.ts`：`KeyValueStore` 接口 + JSON 原子落盘（可换 sql.js）；`lock.ts` per-key mutex 串行化文档级读写。
- `chat-session.ts`：会话 CRUD、消息回合（superseded 视图）、单会话单活动 run、审批决议与**续跑**；无 client context 时经 `contextResolver` 服务端组装；**Session Rolling Memory**（见 §5.1.1）。
- `session-memory.ts`：滚动摘要预算/水位线/组装与 roll 纯逻辑。
- `run-engine.ts`：一次 agent attempt 的执行与记录——结构事件持久化（tool/approval/artifact/sources/终态），`message.delta` 仅透传；审批出现则终态为 `waiting-approval`（停车）。
- `project.ts` / `project-plan.ts`：项目 **Plan/Run/ChangeSet** 状态机与统一 DAG 调度器（strategy 仅建边与并发）、任务级审批停车、增量指令失效、成员 replan merge、取消/重试、协调汇总；并发写由 mutex 保护。
- `types.ts` / `events.ts` / `hub.ts`：规范记录、统一 OrcEvent、进程内发布订阅（供 SSE）。
- `runner.ts`/`echo-runner.ts`：真实 agent-core runner 与无网确定性 runner（验收/冒烟用）。

### 5.1 会话与“可续跑 run”

```
客户端/通道 POST /api/orch/sessions/:id/messages {content}   （context 可省）
  → ChatSessionService.sendUserMessage
      → 服务端组装上下文（KV 员工/技能/偏好 + keyring 模型/搜索）
      → requestForTurn：注入 session.memory.summary + 未覆盖原文（或全量历史）
      → RunEngine.execute：工具审批 → 事件流出（SSE）→ 终态 waiting-approval
  → settleRun：写回 transcript；阈值滚动摘要；标记 dirty
  → /approvals/:id/resolve {allow, scope?}
      → engine 记录决议、写入 grants → 自动续跑同 turn 新 attempt
  → 会话/运行记录持久化（重启可恢复、桌面与网关同源）
  → 切换会话时 POST /sessions/:id/memory/flush（桌面离开钩子）
```

#### 5.1.1 Session Rolling Memory（会话级滚动记忆）

长对话的**本会话**连续性，不是跨会话用户画像。

| 原则 | 说明 |
| --- | --- |
| 真相源 | `ChatSession.messages` 始终完整保留；summary **从不**替代 transcript |
| 派生状态 | `memory.{summary, coveredUntilId, updatedAt, dirty}` 挂在同一 session 记录上（domain KV） |
| 打开/续聊 | 有摘要时模型只看到 summary 注入块 + 水位线之后的原文；UI 仍可展示全文 |
| 阈值滚动 | `summary + 未覆盖原文` ≳ 24k 字符 → LLM 摘要旧段、推进 `coveredUntilId`、保留最近 ~8 条原文 |
| Flush | 桌面 `startChat` / `selectConversation` 离开时调用 flush；强制折叠超出最近窗口的增量并清 `dirty` |
| 与 step compaction 关系 | `agent-core` 的 `prepareStep` 只压缩**当次 run**；会话记忆跨重开、跨多次 run |

实现入口：`packages/orchestrator/src/session-memory.ts`、`packages/orchestrator/README.md`。
桌面普通对话在 Electron 内自动走该路径（双模式；协作者等旧特性降级保留）；`message.delta` 对 IM/网关当前采用**终态轮询回传**（确定性），SSE 直播列入后续迭代。

### 5.1.2 项目双工作区与交付物晋升

项目执行刻意拆成两层目录：

| 层 | 路径 | 可见性 | 用途 |
| --- | --- | --- | --- |
| Run workspace | `~/.workmate/workspaces/<runId>/` | 不对用户文件树展示 | 过程脚本、`.py`/`.sh`、临时生成器 |
| Project workspace | `~/.workmate/projects/<name>-<id>/` | 左侧「项目文件」树 | 最终交付（HTML/CSS/JS/文案/图片…） |

规则：

1. 工具默认只写 run workspace（`write_workspace_file` / `run_workspace_script`）。
2. 项目任务请求注入 `projectWorkspacePath` + 与编排层一致的 `runId`。
3. 推荐在交付就绪时调用 `publish_to_project` 即时晋升；**run 正常结束时平台还会自动扫一遍 run workspace 并晋升交付物**（`promoteWorkspaceDeliverablesToProject`），不依赖模型是否记得调用工具。过程脚本（`.py`/`.sh`、`tools/`/`scripts/`/`tmp/`）一律拒绝晋升。
4. 客户端仍按 task `runId` 做 deliverable sync 兜底；若编排 `runId` 与 agent 实际工作区目录曾不一致，会从 `RunRecord.eventLog` 解析真实 workspace id。sync 的 `cpSync` filter **必须允许目录遍历**，否则根目录/子目录一旦返回 false 会整树跳过。
5. 事件：`project.file.published` → UI 刷新文件树。

实现：`packages/agent-core/src/skill-runtime.ts`（`publish_to_project` / auto-promote）、`packages/orchestrator/src/project.ts`（注入路径）、`apps/desktop/.../index.cjs`（sync）、`apps/renderer/.../ProjectConversationWorkspace.vue`。

### 5.1.3 多 session / 多用户并发治理

当前单机并发治理采用“两层调度”：

1. `InMemoryExecutionDispatcher` 负责会话串行、全局/单用户容量限制、显式等待队列、排队超时，以及 `chat` 高优先级与 `project-task` 普通优先级的防饥饿调度；
2. `agent-core` 中的 AgentScope sidecar pool 负责 Python 进程级分流、单实例容量限制、异常摘除、冷却恢复、自动补位、平滑缩容，以及 `startRun` 阶段失败时的一次安全切换重试。

隔离键当前已覆盖：

- `orgId`
- `userId`
- `sessionId`
- `runId`

运行时观测入口：

- `GET /api/runtime/status`
- `GET /api/runtime/status/stream`
- 设置页 `通用 -> 运行时并发状态`

详细说明见：

- `docs/design/concurrency-runtime.md`
- `docs/design/concurrency-verification.md`

### 5.2 项目编排：Plan / Run / ChangeSet（P0–P1）

项目调度从「整表重写任务列表」升级为**版本化计划 + 增量失效 + 统一 DAG 执行**：

```text
Goal
  → Coordinator / 模板 产出 Plan v1（tasks + DAG edges + 可选 contract）
  → 人确认 → 打开 ProjectRun（绑定 planVersion）
  → Scheduler 始终按 DAG：dependsOn 满足才就绪；mode 只决定并发度与「如何生成边」
  → 用户 @员工 发指令 → ChangeSet(instruction)
        · 目标任务 append 指令并标 stale
        · 下游依赖级联 stale（上游 completed 保留）
        · 新开 Run，只重跑 stale/失败节点
  → 成员增删 → Plan vN+1（replan）
        · merge：尽量保留可复用的 completed 节点
        · 移除节点 → superseded（历史保留，不参与调度）
```

| 概念 | 说明 |
| --- | --- |
| **Plan** | `project.plan`（version / strategy / taskIds）；`planHistory` 仅存元数据 |
| **Run** | `ProjectRun` 一次执行实例，携带 `planVersion` / 可选 `changeSetId` |
| **ChangeSet** | 增量变更记录（instruction / replan / invalidate），写入 `project.changeSets` |
| **stale** | 因上游或指令失效、需重跑；不等于删除 |
| **superseded** | 已退出当前 Plan，仅作历史 |
| **contract** | 可选任务契约：`outputs` / `acceptance` / `timeoutMs` / `maxAttempts` |

**统一 DAG**：`waterfall` / `discussion` 在建图时物化为线性 `dependsOn`；`parallel` 无边；`dag` 使用显式边。运行时 `drain` 只走依赖就绪集；策略控制并发。调度为 **P2 混合事件驱动**：就绪批次 await 完成，审批停车靠 `notifySchedule` 唤醒。任务 attempt 带 **P3 idempotency key**（`lastAttemptKey`）。

新建时协作模板为**偏好**：协调员两阶段规划（结构→目标）；图形态与偏好不符时弹窗建议切换（见 `project-orchestration.md`）。

API：

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| confirm | `POST /projects/:id/confirm` | 打开 Run；completed/superseded 跳过，其余入队 |
| instructions | `POST /projects/:id/instructions` | ChangeSet + 级联 stale + confirm |
| replan | `POST /projects/:id/replan` | Plan vN+1 merge + 依赖校验 |

实现：`packages/orchestrator/src/project-plan.ts`、`project.ts`；桌面镜像见 `apps/renderer/.../ProjectsPage.vue`。

### 5.2.1 项目调度（执行环）

```
创建(本地生成草案/模板) → POST /api/orch/projects(draft, Plan v1)
→ confirm {}（服务端按任务员工组装模型/Skills/权限档）
→ ProjectService.runScheduler/drain：
    DAG 依赖解析、策略并发、任务级审批 park、
    取消(abort+队列标记)、失败重试(contract.maxAttempts)、完成汇总
→ 任务 transcript、项目 runs、SSE project 主题事件（桌面轮询/订阅镜像）
```

> 旧称「按 mode 分支串行/并行两套调度」已废弃；mode 只影响建图与并发。
### 5.3 域存储与密钥（单写者 + keyring）

- Main 的 `storage-get/set` → 转发 `/api/orch/kv`（失败降级旧 sql.js）；启动时一次性迁移旧域键（跳过密钥键）。
- 模型/搜索/通道 token：Main sql.js + `safeStorage`；经 fork IPC（`workmate:secrets` / `workmate:channels:secrets`）一次性下发给子进程，绝不落盘 domain.json。

## 6. 通道与远程办公（M1/M2）

协议层 `packages/channel`：`UnifiedMessage / UnifiedReply / StreamSink / IChannel / IInboundTransport / IOutboundTransport`；`registry`（注册/分发/启停）；`core.handleChannelMessage`：授权 → 优先 `sendStream` 占位+累积（节流），否则整段收集一次发送。

`apps/gateway`：`GatewayRuntime.process` 把「通道:线程」映射为服务端会话；文本指令面：`/chat /employee /pending /approve|deny <id> /projects /project <id>|start|cancel`；白名单规则 `channel:user/chat[:user]`（默认拒绝）。

| 适配器/通道 | 入站 | 出站 | 状态 |
| --- | --- | --- | --- |
| Telegram | 长轮询 getUpdates | sendMessage / editMessageText 流式 | 代码+桩验收；真机待凭证 |
| 飞书 Feishu | WS 长连接 `im.message.receive_v1`（去重） | text / interactive 卡片 create→patch 流式 | 代码+桩验收；真机待凭证 |
| 远程中继 Relay | 中继服务器转发请求 | 信封 `request/response/event` | 最小实现+桩验收；公网部署待做 |

中继协议（`apps/gateway/src/relay/*`）：设备 `hello` 注册、`params.deviceId` 路由、`device.ping` 心跳直答、响应回路由；`RelayDeviceClient` 主动出连（心跳/指数退避重连），请求 `message {text}` 复用 `GatewayRuntime` 指令面。

## 7. 构建 / 发布

- 包顺序（根与 desktop 的 build 脚本）：contracts → tools → storage → **channel → gateway** → agent-core → orchestrator → api → renderer。
- dev：`apps/desktop/scripts/dev.mjs` 串行构建依赖后起 Vite + Electron（main/preload 变更才重启 Electron）。
- 发布 CI（`release.yml`）：macOS arm64(macos-14)、macOS Intel x64(macos-13)、Windows x64 三个原生 runner → dmg/dmg/exe；publish 校验恰 3 个安装包并生成 SHA-256。
- 无头验收脚本：`scripts/headless-gateway-smoke.mjs`、`remote-project-confirm.mjs`、`remote-chat.mjs`、`gateway-stub-smoke.mjs`、`gateway-feishu-smoke.mjs`、`relay-smoke.mjs`。

## 8. 验收与状态

| 里程碑 | 交付 | 验收证据 |
| --- | --- | --- |
| M0 编排层 | orchestrator + /api/orch + 域单写者 + 可续跑审批 | 单测 11/11；HTTP/远程冒烟 ALL PASS；桌面项目/会话接入（编译级） |
| M1 网关+Telegram | channel 协议 + gateway + Telegram/白名单 | channel 4/4；gateway-stub ALL PASS |
| M2 门户/飞书/中继 | IPC 凭证链路 + 远程办公页(P1) + 飞书 + relay | feishu/relay 桩验收 ALL PASS；typecheck/build 全绿 |

细节与真机人工步骤见各里程碑文档。

## 9. 已知限制与后续

- 网关对 IM/中继的会话回复目前为**确定性轮询取终态**；SSE 直播（先订后发问题）待迭代。
- 中继为**纯转发最小实现**：无订阅/广播/离线队列；外部终端 Web 控制台与设备配对 UI 待做。
- `packages/storage`、`packages/ui-kit` 仍为占位；部分旧文档（`docs/architecture/overview.md`、`docs/sdd/*`）为早期描述，以本文档与 `docs/design/*` 为准。
- 用户/身份体系未实现（白名单字符串、默认拒绝）。
