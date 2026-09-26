# 架构与契约

> 状态：实施中｜规格版本：0.1｜更新日期：2026-09-23

## 检索链路

```text
用户问题
  ├─ 原问题向量召回（保底）
  └─ 本体查询规划
       ├─ 实体/别名归一化
       ├─ 一跳关系扩展
       ├─ 增强查询
       └─ 文档与来源提示
              ↓
        增强向量召回
              ↓
候选合并、去重、图谱提示加权
              ↓
后续：权限/时效/版本过滤与 reranker
              ↓
大模型基于证据回答
```

图谱不是正文仓库。节点和关系负责表达“是什么、与谁有关、去哪找”；知识库切片负责提供可引用原文。

## 数据模型

- `OntologyNode`：`id/type/name/aliases/properties/source/status`；
- `OntologyEdge`：`subjectId/predicate/objectId/properties/source/status`；
- `OntologyGraph`：版本化节点和关系集合；
- `OntologyQueryPlan`：匹配节点、相关节点、关系、扩展词和过滤提示。

第一阶段按知识库数据目录保存 `ontology.json`；本地切片仍由 LanceDB或现有文件回退存储。二者通过 `documentId`、`source` 等稳定引用关联。

## API

| API | 作用 |
| --- | --- |
| `POST /api/knowledge/ontology/replace` | 校验并整体替换图谱 |
| `POST /api/knowledge/ontology/read` | 读取知识库图谱 |
| `POST /api/knowledge/ontology/query` | 生成确定性查询计划 |
| `POST /api/knowledge/hybrid-search` | 执行原始与本体增强的混合检索 |

混合检索返回 `query/plan/strategy/results`。`strategy` 为 `vector-only` 或 `ontology-enhanced`，用于调试与评测，不表示答案可信度。

## 模块边界

- 公共 Schema：`@workmate/contracts`；
- 图谱存储、查询规划和检索融合：`@workmate/agent-core`；
- HTTP 路由：`apps/api`；
- API 负责写入，renderer 不直接访问文件；
- 第一阶段查询规划不调用大模型，保证可复现和可测试。

## 安全与降级

- `archived` 节点和关系不参与召回；
- 图谱命中只加权，不作为绕过权限的依据；
- 图谱为空、损坏或无命中时，返回空计划并保留原始向量路径；
- 后续权限过滤采用“用户权限 ∩ 数字员工权限 ∩ 项目权限”。
