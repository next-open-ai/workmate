# 测试规格

> 状态：实施中｜规格版本：0.1｜更新日期：2026-09-23

| ID | 场景 | 预期 |
| --- | --- | --- |
| ONT-TEST-01 | 写入后重新读取图谱 | 节点、关系和版本保持一致 |
| ONT-TEST-02 | 用别名查询实体 | 返回标准实体及扩展词 |
| ONT-TEST-03 | 查询有一跳关系的实体 | 返回关联节点和关系 |
| ONT-TEST-04 | 图谱为空或无匹配 | 策略为 `vector-only`，原向量检索正常 |
| ONT-TEST-05 | 图谱匹配且关联文档 | 原始与增强路径合并去重，提示文档合理加权 |
| ONT-TEST-06 | archived 节点或关系 | 不进入查询计划 |
| ONT-TEST-07 | 非法 API 输入 | 返回 400 和契约错误，不写入文件 |
| ONT-TEST-08 | 无权限/过期/错误版本候选 | 在进入模型上下文前被硬过滤（P2） |

## 当前自动验证

```bash
pnpm --filter @workmate/contracts build
pnpm --filter @workmate/agent-core typecheck
pnpm --filter @workmate/api typecheck
pnpm --filter @workmate/agent-core test
```

阶段验收还必须覆盖一次真实 Embedding 服务和 LanceDB 的端到端混合检索，不以纯单元测试代替。
