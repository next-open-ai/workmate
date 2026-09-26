# 工程治理中心

本目录是编码智能体与开发者的工程治理入口。产品需求从 `docs/product/` 进入；全局架构以 `docs/architecture/architecture.md` 为准；功能行为以 `docs/sdd/features/` 为准；项目计划见 `docs/planning/`，回归与验收见 `docs/quality/`，平台评测见 `docs/benchmarks/`。

| 文档 | 说明 |
|------|------|
| [architecture.md](./architecture.md) | 分层与依赖方向 |
| [testing.md](./testing.md) | 回归与冒烟 |
| [coding-standards.md](./coding-standards.md) | 编码标准 |
| [sdd-workflow.md](sdd-workflow.md) | SDD 准入、实施和验证流程 |
| [documentation.md](documentation.md) | 文档分层、权威性和归档规则 |
| [review-checklist.md](review-checklist.md) | 规格和代码评审清单 |
| [agent-guidelines.md](agent-guidelines.md) | 编码智能体规则导读 |

仓库入口红线以根 `AGENTS.md` 为准；文档站内参见 [编码智能体规则导读](agent-guidelines.md)。

## 按问题选择规则

| 当前问题 | 首先阅读 | 必要时继续阅读 |
| --- | --- | --- |
| 代码应该放在哪个模块 | [architecture.md](architecture.md) | 全局架构、相关 ADR |
| 如何实现和组织公共代码 | [coding-standards.md](coding-standards.md) | 对应包的现有实现与测试 |
| 新功能如何从需求进入编码 | [sdd-workflow.md](sdd-workflow.md) | 功能 SDD、生命周期 |
| 应该运行哪些测试 | [testing.md](testing.md) | 质量中心、功能 test-spec |
| 文档应该放在哪里 | [documentation.md](documentation.md) | 文档中心、Archive |
| 是否满足合入条件 | [review-checklist.md](review-checklist.md) | status、测试报告、Deliverable |

## 工程变更闭环

任何公共行为变更都应形成以下闭环：

```text
需求/缺陷 → 规格与任务 → 契约和实现 → 分层测试 → 状态与证据 → 发布/归档
```

工程规则只说明“如何工作”，不复制产品需求、功能状态或测试结果。发现规则与实现长期不一致时，应先确认真实行为，再修改事实源和回归测试，不允许仅修改说明掩盖偏差。

## 维护责任

- 修改模块边界、依赖方向或所有权：更新 `architecture.md` 和必要的 ADR；
- 修改编码约束或安全要求：更新 `coding-standards.md` 与根 `AGENTS.md`；
- 修改开发阶段、状态或准入要求：更新 `sdd-workflow.md`；
- 修改测试分层或证据要求：更新 `testing.md` 和 `docs/quality/`；
- 修改目录、事实源或归档规则：更新 `documentation.md`、文档中心和 VitePress 导航；
- 修改评审门禁：更新 `review-checklist.md`。
