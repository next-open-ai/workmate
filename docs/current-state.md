# Workmate 当前功能状态

> 实现快照日期：2026-10-07  
> 口径：以当前工作区实现、功能 SDD 和已执行回归为准；“已实现”不自动等于真实 Provider、真实设备或安装包验收完成。

## 当前产品能力

| 能力域 | 当前状态 | 事实源 |
| --- | --- | --- |
| 对话与数字员工 | 服务端会话、滚动记忆、工具审批、资产交付和员工权限已接入 | [全局架构](architecture/architecture.md) |
| 持续任务 | 复杂任务可保存源文件、检查点和工作区，跨 run 恢复；完成后自动收敛，清空消息不等于删除 Session | [持续任务 SDD](sdd/features/conversation-durable-task/README.md) |
| 应用模型 | 图片生成/理解、Embedding、ASR、TTS、量子代码、决策和本体语义匹配统一按能力注册；Provider 使用“厂商模板→连接→服务端点→模型”，阿里/火山/智谱支持服务化自动端点；员工端使用一个总开关 | [应用模型 SDD](sdd/features/application-model-capabilities/README.md) · [统一 Provider](sdd/features/unified-provider-connections-v1/requirements.md) |
| 决策守卫 | 决策模型纳入应用模型管理，可用于工具执行前守卫和主模型按需调用；默认关闭、超时降级并支持扩展其他决策模型 | [决策运行时](sdd/features/decision-runtime/jev-decision-runtime.md) |
| 知识库与本体 | 普通文档解析后可生成候选本体；支持引导、审核、发布、两跳图查询、语义实体链接及 `kb_search` 增强检索 | [本体 RAG 状态](sdd/features/ontology-rag-phase-1/status.md) |
| 实时语音 | 桌面实时对话与独立 ASR 已模块化；实时凭证、模型、音色和端点统一归入 Provider/模型；运行时通过可扩展适配器支持火山 SeedDuplex 与阿里 Qwen Audio/Omni Realtime、Function Calling 工作桥、简短完成播报、5 秒长静音 mute 和旧配置回退 | [实时语音状态](sdd/features/realtime-voice-v1/status.md) |
| 手机对话 | 提供 HTTP 文字/文件快捷入口和 HTTPS 安全语音入口；TLS 前置只暴露手机对话路径 | [手机语音](sdd/features/realtime-voice-v1/mobile-voice.md) |
| 项目与自动化 | Plan/Run/ChangeSet DAG 项目编排、可续跑审批、自动化和双工作区交付已接入 | [项目编排](architecture/project-orchestration.md) |
| 测试网站 | 独立本机质量控制台可运行白名单回归、并发专项并保存日志/报告，默认端口 `47840` | [测试控制台 SDD](sdd/features/test-console-v1/requirements.md) |

## 运行与端口

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| Renderer 开发界面 | `127.0.0.1:47831` | 避开常见的 `5173` |
| Workmate API | `127.0.0.1:47832` | Desktop、Web launcher 与 Gateway 共用正式 API |
| 手机 HTTPS 前置 | 独立可配置端口 | 仅代理 `/api/chat-mobile/`，不暴露管理接口 |
| 测试控制台 | `127.0.0.1:47840` | `pnpm quality:console` 启动 |

默认数据目录为 `~/.workmate`。端口可由对应环境变量覆盖，但客户端、代理和测试目标必须同步。

## 已知验收边界

- Provider mock、类型检查和构建通过不代表所有第三方模型账号、地域、额度和内容安全策略已经真实验收。
- 实时语音具备真实服务握手证据，但不同麦克风、手机浏览器、证书信任和弱网仍需目标设备人工验收。
- 本体增强已进入默认 `kb_search` 链路，但细粒度知识权限、稳定文档版本绑定和真实业务数据集评测仍需继续完善。
- 测试控制台仅面向本机工程测试，不是生产多用户测试平台，也不开放远程命令执行。

## 同步规则

功能变化时依次更新：功能 SDD → 本页 → 产品/架构/质量索引 → 用户手册 → 应用内手册派生文件。历史交付快照和 Archive 不回写为当前状态。
