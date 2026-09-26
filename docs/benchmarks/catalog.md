# Benchmark 目录

| ID | 领域 | 评测目标 | 当前基础 | 状态 |
| --- | --- | --- | --- | --- |
| BM-CONC-001 | Runtime | 多 session、多用户吞吐、公平性和尾延迟 | concurrency regression/loadtest | 待固化基线 |
| BM-SIDECAR-001 | Runtime | Sidecar 冷启动、池利用率、自愈和缩容 | AgentScope smoke/runtime status | 待建立 |
| BM-GW-001 | Integration | Gateway 消息端到端延迟、丢失和重连 | gateway/relay smoke | 待建立 |
| BM-EMB-001 | Knowledge | Embedding 吞吐、兼容性和检索质量 | embedding provider 方案 | 待建立 |

新增评测必须分配稳定 ID，并链接评测规格、数据集、基线和报告；不能只记录一个结果数字。
