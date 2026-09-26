# 自动化回归套件目录

> 状态：按仓库当前脚本整理  
> 更新日期：2026-09-23

| 回归 | 命令/脚本 | 覆盖 | 触发条件 |
| --- | --- | --- | --- |
| 全量包测试 | `pnpm test` | 包级单元与公共行为 | 所有公共变更 |
| 图片理解闭环 | `node scripts/vision-chat-regression.mjs` | 鉴权、上传、Pi原生图文及文本主模型→识图工具双路径、原问题传递、进度、追问、引用持久化、清理 | 识图、附件、会话、模型配置变更；先按依赖顺序构建 API |
| 类型检查 | `pnpm typecheck` | 全包类型契约 | TypeScript/契约变更 |
| 生产构建 | `pnpm build` | 包依赖、产物构建 | 合入前/发布候选 |
| 并发回归 | `pnpm concurrency:regression` | dispatcher、sidecar pool、隔离、自愈 | 并发/运行时变更 |
| 并发负载 | `pnpm concurrency:loadtest` | 容量和尾延迟 | 并发基线/发布候选 |
| dsh 回归 | `pnpm dsh:regression` | dsh MCP/Skills 桥 | dsh、MCP、Skill 变更 |
| Headless Gateway | `scripts/headless-gateway-smoke.mjs` | 会话、审批续跑、项目并行 | orchestrator/API 变更 |
| Gateway stub | `scripts/gateway-stub-smoke.mjs` | Telegram 桩、白名单、指令 | gateway 变更 |
| Feishu smoke | `scripts/gateway-feishu-smoke.mjs` | 解析、去重、会话、白名单 | 飞书适配变更 |
| Relay smoke | `scripts/relay-smoke.mjs` | 设备注册、终端 chat、指令面 | relay 变更 |
| AgentScope smoke | `scripts/agentscope-smoke.mjs` | hello、health、事件流 | AgentScope 变更 |
| MCP user scope | `scripts/mcp-user-scope-regression.mjs` | MCP 用户隔离 | MCP 权限变更 |
| 模板任务 | `pnpm tasks:smoke` | 模板任务运行 | 模板/任务变更 |

## 维护规则

- 新增脚本时补充入口、覆盖范围、依赖环境和期望证据；
- 脚本改名必须同步 CI、package scripts、本文档和关联测试规格；
- 功能 SDD 应引用本目录已有回归，避免复制命令；
- 回归失败需要报告根因，不允许以“偶发”无证据跳过。
