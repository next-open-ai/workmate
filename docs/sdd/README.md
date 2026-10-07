# Workmate · SDD 规格索引

本目录将“需求—设计—验证”作为同一条可追溯链路维护。它不是静态说明书：每次改变核心业务行为时，应同步更新受影响的规格与测试用例。

## 当前功能规格包

| 功能 | 入口 | 状态 |
| --- | --- | --- |
| 统一 Agent Tool Interface | [features/unified-tool-interface/README.md](features/unified-tool-interface/README.md) | 已同步实现，待 Workmate 真实引擎验收 |
| 通用应用模型机制 | [features/application-model-capabilities/README.md](features/application-model-capabilities/README.md) | 已同步实现，待真实 Provider 验收 |
| 应用模型耗时与进度 | [requirements](features/application-model-timing/requirements.md) | 已形成需求与回归规格 |
| 对话多媒体资产预览 | [M1](features/assets/M1-chat-media-preview.md) | 图片缩略图、音频播放等已接入 |
| 对话附件 | [requirements](features/chat-attachments/requirements.md) | 已接入受控附件与资产晋升 |
| Markdown 呈现 | [requirements](features/chat-markdown-presentation/requirements.md) | 已形成显示与回归规格 |
| 持续任务 | [features/conversation-durable-task/README.md](features/conversation-durable-task/README.md) | 源文件、检查点、跨 run 恢复和自动完成已实现 |
| 决策模型运行时 | [JEV 与可扩展决策运行时](features/decision-runtime/jev-decision-runtime.md) | 默认关闭，可作 Tool 前置守卫和按需能力 |
| 图片理解：主模型直读/应用模型定向识图 | [features/image-understanding/README.md](features/image-understanding/README.md) | Pi M1/M2 工程闭环通过，待真实 Provider/安装态验收 |
| 知识库 Embedding 选择 | [requirements](features/knowledge-embedding-selection/requirements.md) | 已形成配置与回归规格 |
| 本地文档导入 | [features/local-document-ingest/README.md](features/local-document-ingest/README.md) | PDF/Word 等解析链路已接入 |
| 手机对话传文件 | [desktop-file-transfer](features/mobile-chat/desktop-file-transfer.md) | 默认下载/文档目录保存已实现 |
| 紧凑账户入口 | [M1](features/navigation/M1-compact-account-menu.md) | 已实现 |
| 本体增强 RAG 第一阶段 | [features/ontology-rag-phase-1/README.md](features/ontology-rag-phase-1/README.md) | 构建、审核、发布、增强检索已接入；业务评测继续完善 |
| 实时语音 V1 | [status](features/realtime-voice-v1/status.md) | 桌面/手机、工作桥和长静音治理已实现；真实设备继续验收 |
| 默认端口治理 | [default-ports](features/runtime-ports/default-ports.md) | Renderer/API 已避开 5173 |
| 统一测试控制台 | [features/test-console-v1/README.md](features/test-console-v1/README.md) | 本机网站、白名单执行和持久记录已实现 |
| 语音服务模块化 | [status](features/voice-services-modularization-v1/status.md) | 实时通话与独立 ASR 已解耦并兼容旧配置 |
| Windows 手册性能 | [requirements](features/windows-manual-performance/requirements.md) | 已形成规格与回归入口 |
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
