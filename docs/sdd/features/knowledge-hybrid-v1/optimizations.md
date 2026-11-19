# KH-T5～T8：Wiki优化与离线报告同步

状态：实施中；日期：2026-10-21；版本：1。来源为WorkExpert当前工作区，目标两产品共同业务；保留原有未提交修改。

## 需求、任务及契约

- KH-R5/T5 → WK-D17-T：生成阶段queued/generate/merge/save/link/done与批次进度，失败详情折叠；重新生成只预选仍存在资料，再确认才调用当前模型。
- KH-R6/T6 → WK-R18-T：显式resumeJobId继续原任务；已有校验批次和稳定页面ID复用，来源/模型/方案匹配、同库并发限制、最多20个恢复幂等键。不自动重启计费。旧任务无检查点时只支持重新生成。
- KH-R7/T7 → WK-M19-T：新未发布草稿按标题/别名精确匹配同库当前已发布主题；预览保留目标人工草稿，追加章节，仅完全相同正文/证据/链接去重。双方版本与预览hash校验，仅保存新草稿；源草稿保留，不自动发布或语义合并。GET merge-candidates/merge-preview及POST merge沿用原库授权。
- KH-R8/T8 → KEV-TEST-01：召回测试内按需加载离线报告，手动导出已有结果ID/标题，导入人工标注冻结JSON生成HTML。无查询钩子、后台采样、模型裁判、自动调参或报告持久库。文件上限2MiB、100题、5方案、TopK20；null未标注拒绝，空组集合为无答案题；同组证据只计一次，缺失耗时不虚构。契约以contracts为准，导入核对库ID，不验证当前资料版本。

## 分层、数据与差异

新增contracts DTO；storage沿用SQLite v6任务JSON的私有 `_checkpoint`，与进度原子保存，公开读剥离候选正文；orchestrator持有任务与恢复逻辑；API复核来源；renderer仅交互。无表迁移、不操作真实用户库。模型调用仍仅agent-core；EasyMate保持单Pi。保留两产品端口、会话头、品牌、库授权、文档解析与远程Provider。

本次不迁入WorkExpert的独立Wiki阅读窗口/导出、一跳扩展、本体增强、所有权认领；不接统一Reranker，不自动跑评测题库。报告不纳入查询执行链。UI沿用现有页签，报告默认折叠；继续生成有计费确认；合并只新增一个按需面板，错误可重试。用户手册分别同步。

## 测试与回滚

临时SQLite、模型桩验证事务/CAS/幂等/来源隔离/恢复及合并API；存储、编排、API相关包测试和构建，renderer构建、离线指标回归、业务同步parity、并发回归和文档构建。界面以浏览器测试验证入口；未执行项必须记录，不继承源项目通过结论。

回滚可移除新入口及API，但须保留能读取新增progress和私有checkpoint的contracts/storage兼容层；不可降级或删除真实库。离线报告无需迁移。当前执行证据见[optimization-status](optimization-status.md)。
