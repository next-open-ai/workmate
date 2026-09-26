# Workmate 项目需求规格总览

> 状态：当前总览  
> 更新日期：2026-09-23  
> 说明：本文件是项目级需求和评审导航，不替代功能 SDD 中的详细需求。

## 项目级需求

| 编号 | 需求 | 详细入口 |
| --- | --- | --- |
| WM-REQ-001 | 支持多 Provider、多模型和可替换运行时。 | [全局架构](../architecture/architecture.md) |
| WM-REQ-002 | 数字员工在职责、Skill、知识和权限边界内执行任务。 | 功能 SDD；[历史需求](../archive/legacy-global-sdd/requirements.md) |
| WM-REQ-003 | 对话和项目任务可以调用受控工具并产生可追踪资产。 | [项目编排](../architecture/project-orchestration.md) |
| WM-REQ-004 | Desktop、Web/API、消息通道共享稳定契约并具有明确降级行为。 | [运行形态](../guides/runtime-modes.md) |
| WM-REQ-005 | 需求、设计、任务、测试、Benchmark、阶段成果和发布结果可追溯。 | [SDD 工作流](../engineering/sdd-workflow.md) |

## 项目级质量属性

| 属性 | 要求 |
| --- | --- |
| 安全 | 凭据不进入域数据和日志；高风险动作需授权；执行边界受控 |
| 可追溯 | 会话、运行、工具、审批、模型、产物和测试结果可关联 |
| 可恢复 | 失败、取消、重试和回滚具有明确语义 |
| 模块化 | Renderer、API、Orchestrator、Agent Core、Tools 和 Contracts 边界稳定 |
| 兼容性 | 配置和公共契约版本化，迁移失败不破坏原数据 |
| 可测试 | 公共行为有回归，外部服务可 mock，人工测试有证据 |
| 可观测 | 并发、模型、工具、Sidecar、错误和资源指标可查询 |
| 本地优先 | 核心桌面和本地运行不依赖云端控制平面 |

## 当前功能 SDD

新跨模块功能必须在 `docs/sdd/features/<feature>/` 建立独立规格包。当前功能见 [SDD 索引](../sdd/README.md)，图片理解见 [VIS-001](../sdd/features/image-understanding/README.md)；既有历史规格见 [归档](../archive/legacy-global-sdd/README.md)。
