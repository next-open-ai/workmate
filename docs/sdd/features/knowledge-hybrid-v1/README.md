# KH-v1 · 三路知识创建与召回

新增授权：[KH-T5～T8 Wiki优化与离线报告](optimizations.md)，本轮状态独立记录在[optimization-status](optimization-status.md)。

状态：已实现，自动化分层验证通过；真实模型与桌面人工验收未执行。2026-10-21。来源：同仓 Workexpert（61c5adf），限定向量、全文、Wiki 三条路径。

## 需求、契约与任务

- KH-R1/T1：本地导入保存不可变原文、版本证据和结构化块；LanceDB 向量与 SQLite FTS5/BM25 等权 RRF 融合。旧块可补全文索引但不伪造版本；删除和有效头切换同步过滤召回。无 Embedding 时允许全文召回；向量失败有关键词时显式降级，不吞全文存储错误。
- KH-R2/T2：Wiki 使用同库证据，显式生成草稿、人工发布、编辑和浏览；仅已发布且来源有效的页面参与可选融合。生成任务由 orchestrator 调度，模型仅由 agent-core 调用。草稿、过期/删除来源不能泄露进召回。复用 Workexpert 的版本校验、幂等、备份与取消规则。
- KH-R3/T3：统一 search 和 kb_search 可返回 evidence/retrieval/wiki 元数据；Wiki 是派生材料，不计作独立证据。Wiki 融合默认关闭，可在库配置开启。保留现有远程 Provider、Embedding 选择、文档解析服务和本体能力，不迁入 Workexpert 本体增强、图检索、Wiki 一跳扩展或独立窗口导出。
- KH-R4/T4：客户端不得提交可信 Wiki 访问身份/路径；API 从已保存库配置和认证身份生成运行上下文。沿用 Workmate 现有库配置授权模式，不迁移 Workexpert 旧库认领/所有权策略。Wiki 原文归档按认证用户隔离。共享业务同步 EasyMate，仍只用单 Pi。

## 测试规格与追踪

KH-T1 → 存储事务/版本冲突/删除/FTS中文与RRF/向量故障降级回归；KH-T2 → 草稿发布、来源撤销、生成幂等/取消/重启、API认证与跨用户测试；KH-T3 → renderer构建、配置持久化和工具召回；KH-T4 → 可信上下文拒伪造及 EasyMate 同步检查。测试仅临时库与桩模型，真实模型、安装态和性能验收另记。

## 兼容与回滚

不搬动或执行真实用户数据迁移。运行期首次本地导入/召回建立 evidence SQLite，旧块只补关键词索引。显式 Wiki 生成前使用 SQLite 一致备份并升级至来源实现的 v6；普通 evidence 为 v4并兼容v5/v6。关闭Wiki融合/入口可回退行为，但不能把已有v6文件交给旧严格读写器；保留原文、批次与备份，不删除或降级文件。配置字段向后兼容默认关闭。

## 验证记录

2026-10-21，保留原有任务监控改动及 EasyMate 既有未提交业务同步；未修改 Workexpert 或真实用户知识库。

- KH-T1：Workmate storage 33/33、EasyMate storage 35/35通过。覆盖SQLite迁移/失败回滚、FTS中文、有效头CAS、来源删除及Wiki发布原子性。新来源归档按当前用户保存，不搬动旧原文。
- KH-T2：Agent Core全量Workmate232/232、EasyMate181/181通过；最后调整本地策略标识后，两端知识专项22/22再次通过。orchestrator全量分别108/108、104/104通过，覆盖生成幂等、取消、检查点及重启不重放。
- KH-T3：两端renderer构建（vue-tsc/Vite）、API生产CJS构建、docs:build通过；手册源文件及应用内JSON已更新。新增 `node scripts/knowledge-hybrid-ui-regression.mjs` 执行真实搜索处理函数，覆盖迟到成功/错误抑制、当前错误反馈及Wiki/来源标签接线；不是浏览器视觉验收。
- KH-T4：API全量Workmate134通过+2跳过、EasyMate126通过+2跳过。新增真实Fastify+SQLite+LanceDB闭环：原文上传/下载、向量/全文、模型桩生成/重放、草稿隔离、发布与统一召回、删除失效、伪造身份/路径覆盖、持久化Run身份与停用后拒绝。模型调用只使用测试桩。
- EasyMate API typecheck通过；Workmate API typecheck仍失败于既有 `voice/barge-in.test.ts:65` 的raw隐式any，本次未改该无关文件。其他受影响包构建及类型检查通过。
- Workmate隔离concurrency:regression通过。EasyMate默认concurrency:loadtest因127.0.0.1:4329无服务而失败；其隔离concurrency:regression退出0，但Pi执行场景记录认证失败，不将其记为完整并发执行验收。Wiki调度的并发/取消由专项编排测试验证。
- EasyMate产品隔离和44个登记模块的实时Workmate对比通过，保持单Pi；本体增强、关联扩展、独立窗口导出与库归属认领迁移均未引入。
- 原源项目测试含一跳扩展断言，因不属于本次范围移出；保留原文变化/删除阻断测试。开发中新测试夹具的ChatRequest默认字段和KV桩类型错误已修正，最终回归重新通过，未放宽生产校验。

复现入口：`pnpm knowledge:regression`，以及各产品renderer/API构建、`pnpm docs:build`。未执行真实供应商质量、浏览器/安装态及大库性能评测；SQLite experimental和既有bundle大小警告保留。回滚使用前述关闭入口/保留兼容读写器方案。
