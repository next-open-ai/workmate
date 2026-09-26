# Workmate · SDD 规格索引

本目录将“需求—设计—验证”作为同一条可追溯链路维护。它不是静态说明书：每次改变核心业务行为时，应同步更新受影响的规格与测试用例。

## 当前功能规格包

| 功能 | 入口 | 状态 |
| --- | --- | --- |
| 统一 Agent Tool Interface | [features/unified-tool-interface/README.md](features/unified-tool-interface/README.md) | 已同步实现，待 Workmate 真实引擎验收 |
| 通用应用模型机制 | [features/application-model-capabilities/README.md](features/application-model-capabilities/README.md) | 已同步实现，待真实 Provider 验收 |
| 图片理解：主模型直读/应用模型定向识图 | [features/image-understanding/README.md](features/image-understanding/README.md) | Pi M1/M2 工程闭环通过，待真实 Provider/安装态验收 |
| 本体增强 RAG 第一阶段 | [features/ontology-rag-phase-1/README.md](features/ontology-rag-phase-1/README.md) | 实施中 |
| Windows 开始菜单注册 | [features/windows-start-menu-registration/README.md](features/windows-start-menu-registration/README.md) | 待验证 |

新跨模块功能应进入 `features/<feature>/`，至少包含需求、架构、计划、任务、测试和状态。

## 历史总规格

早期全局需求、概要设计和测试规格已移入 [历史归档](../archive/legacy-global-sdd/README.md)，不再作为当前 SDD 入口。

## 维护约定

1. 先更新需求规格，再调整实现与测试规格。
2. 每项需求使用稳定编号（例如 `PRJ-01`）；设计与测试以同一编号引用它。
3. 涉及执行权限、文件写入、脚本运行、网络访问或删除时，必须同时更新权限规则和负向测试。
4. 发布前至少执行对应模块的类型检查、生产构建及测试规格中的关键人工验收。
5. 每个跨模块功能使用独立 `features/<feature>/` 规格包，并按 [SDD 工作流](../engineering/sdd-workflow.md) 维护。
