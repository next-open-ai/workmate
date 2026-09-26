# Workmate 产品总览

> 状态：当前总览  
> 更新日期：2026-09-23

## 产品定位

Workmate 是本地优先的数字员工与 Agent 工作台，统一组织对话、数字员工、Skills、MCP/工具、知识库、项目编排、自动化、资产和多运行时，并通过桌面、Web/API 和消息通道提供一致能力。

## 核心用户价值

1. 安全配置和使用多个模型服务；
2. 以职责、Skill、知识和权限组织数字员工；
3. 通过受控工具完成对话和项目任务并产出可追踪资产；
4. 对高影响动作执行权限、审批、审计和回滚；
5. 统一编排本地运行时、Sidecar、MCP 和外部模型；
6. 让需求、设计、实现、测试、评测和发布可追溯。

## 能力地图

| 能力域 | 用户入口 | 详细说明 |
| --- | --- | --- |
| 对话与会话记忆 | Chat/Workspace | [全局架构](../architecture/architecture.md) |
| 数字员工与能力授权 | Employees/Capabilities | [历史需求归档](../archive/legacy-global-sdd/requirements.md) |
| 项目编排 | Plan/Run/ChangeSet、DAG | [项目编排](../architecture/project-orchestration.md) |
| 模型与 Provider | 多 Provider、多模型、Embedding | [全局架构](../architecture/architecture.md) |
| Skills、Tools、MCP | 渐进加载、审批和 MCP 桥 | [全局架构](../architecture/architecture.md) |
| 知识库和数据能力 | 本地/云知识库、Embedding | [数据能力平台](../architecture/data-capability-platform.md) |
| 自动化 | 定时运行和记录 | [历史需求归档](../archive/legacy-global-sdd/requirements.md) |
| 通道与远程入口 | Gateway、Telegram、飞书、Relay | [Gateway 设计](../architecture/gateway-m1.md) |
| 多运行时 | pi、AgentScope、dsh | [执行后端](../architecture/execution-backend.md) |

项目级需求见 [需求总览](requirements-overview.md)。
