# 测试规格

| 场景 | 预期 |
| --- | --- |
| 选择继承系统默认 | 保存 `embeddingMode=system`，运行时解析 `activeEmbeddingModelId` |
| 指定模型 | 仅可选择已配置的 Embedding 模型，并保存配置模型 ID |
| 模型不可用 | 保存前明确提示，不产生无效知识库配置 |
| 修改选择 | 已有文档的知识库索引标记为 stale |
| 旧数据 | 无 `embeddingMode` 时继续读取旧的 endpoint/model/key 快照 |
| 服务端对话 | 服务端按引用 ID解析模型和 Provider 密钥 |
| 新建或加载缺省 Embedding 模型 | 显示并保存 1024 / 32 / 8000 / Normalize=true |
| 查看 Embedding 模型配置 | 显示“向量归一化”及用途说明，勾选行为与原 Normalize 配置保持一致 |
| Max Batch 分批 | 5 条输入、批次 2 时按 2/2/1 请求，向量顺序不变 |
| 上游批次更严格 | 首次返回“不得超过 10 条”后自动按 10 重试，后续请求复用已识别上限 |
| Max Input Chars | 每条输入在发送前按模型配置安全截断 |
