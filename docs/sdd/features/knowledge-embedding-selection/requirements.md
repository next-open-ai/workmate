# 知识库向量模型选择需求

> 状态：已实现｜规格版本：1.0｜更新日期：2026-09-29

| ID | 需求 | 验收摘要 |
| --- | --- | --- |
| KB-EMB-01 | 知识库配置应显示当前实际使用的 Embedding Provider、模型和维度。 | 列表、详情和设置页可识别系统默认、知识库指定和旧版配置。 |
| KB-EMB-02 | 向量型知识库可继承系统默认 Embedding，也可指定任一已配置且可用的 Embedding 模型。 | 创建和编辑弹窗只展示 `capability=embedding` 的可用模型。 |
| KB-EMB-03 | 模型选择以配置模型 ID 持久化，运行时解析最新 Provider 连接，不复制作为唯一事实源。 | 修改 Provider 连接后，后续导入、检索和对话使用最新连接。 |
| KB-EMB-04 | Embedding 选择变化且已有文档时，索引应标记为 stale。 | 模式或模型 ID 改变后显示待重建状态。 |
| KB-EMB-05 | 旧知识库保持兼容。 | 未包含选择模式的记录继续使用原有固定 Embedding 字段。 |
| KB-EMB-06 | 新建及旧版缺省的 Embedding 模型应获得统一元数据默认值。 | Dimension=1024、Max Batch=32、Max Input Chars=8000、Normalize=true。 |
| KB-EMB-07 | Embedding 模型配置应以中文解释向量归一化的作用。 | 字段显示“向量归一化”，并提示其对余弦相似度、点积检索和知识库语义检索的影响。 |
| KB-EMB-08 | 知识库向量化必须执行模型的 Max Batch 与 Max Input Chars，并兼容服务端更严格的动态限制。 | 按配置分批；收到可识别的批量上限错误时自动缩批重试并缓存本进程内的实际上限，不丢失输入顺序。 |

## 非目标

- 本期不自动重建已有向量索引；
- 本期不改变 LanceDB、Qdrant、Pinecone 的存储实现；
- 本期不新增或下载 Embedding 模型。
