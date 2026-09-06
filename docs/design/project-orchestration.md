# 项目编排：Plan / Run / ChangeSet（P0–P1）

> 权威摘要亦见 [architecture.md](architecture.md) §5.2。本文展开数据模型与演进动机。

## 动机

早期实现把「规划」和「执行」揉在同一张 `tasks[]` 上：补充指令或改成员时往往整表重写，已完成成果难保留，`mode` 与 `dependsOn` 还存在双语义。P0–P1 目标：

1. **Plan 与 Run 分离**（可版本、可回放）
2. **增量 ChangeSet**（指令 / 失效）代替整图 recreate
3. **统一 DAG 执行**；waterfall/parallel 只是建边策略
4. **任务契约**与 **stale / superseded** 显式失效语义

## 数据模型

```ts
Project {
  plan?: ProjectPlan           // 当前计划元数据
  planHistory?: ProjectPlan[]  // 历史版本元数据（非全量快照）
  changeSets?: ProjectChangeSet[]
  tasks: ProjectTask[]         // 当前 Plan 物化图（含 superseded 历史节点）
  activeRunId?: string
}

ProjectPlan { version, createdAt, strategy, taskIds, note? }

ProjectChangeSet {
  kind: 'instruction' | 'replan' | 'invalidate'
  targetTaskIds, invalidatedTaskIds
  planVersionBefore, planVersionAfter
}

ProjectTask.status:
  draft | queued | running | completed | failed | cancelled
  | stale        // 需重跑
  | superseded   // 已退出当前 Plan

ProjectTask.contract?: { outputs?, acceptance?, timeoutMs?, maxAttempts? }

ProjectRun { planVersion?, changeSetId?, ... }
```

## 运行时

- `applyPlanningStrategy(mode, tasks)`：waterfall/discussion → 链式边；parallel 无边；dag 保留显式边。
- `drain`：**统一 DAG 就绪集**；批次 `await` 执行，审批停车后由 `notifySchedule` **事件唤醒**（P2 混合事件驱动）。
- `dispatchInstruction`：ChangeSet + `invalidateTaskCascade` + `confirm`。
- `replanProject`：`mergeReplanTasks` 保留可复用 completed → Plan vN+1。
- `lastAttemptKey`：`{taskId}:plan{v}:attempt{n}`，同键已完成则幂等跳过（P3）。
- **上下文预算（简单提配）**：依赖证据 / 任务目标 / 项目汇总按 soft→boost 截断，**不中断执行**；步进压缩触达阈值时先提配再摘要（`context-budget.ts` / `context-compaction`）。

## 协调员两阶段规划（P2）与协作偏好

新建项目时，所选模板是**规划偏好**，不是硬约束：

1. **Phase 1**：只产出结构（title / employeeId / dependsOn）与建议模式  
2. **Phase 2**：为固定结构填充 objective / contract  
3. 用图形态推断 `suggestedMode`；若与偏好不符 → UI 弹窗建议切换  

实现：`apps/renderer/src/app/workspace.ts`（`generateProjectDraft`）、`project-planning.ts`、`ProjectsPage.vue`。

## API

| 方法 | 路径 |
| --- | --- |
| 创建草案 | `POST /api/orch/projects` |
| 确认开跑 | `POST /api/orch/projects/:id/confirm` |
| 增量指令 | `POST /api/orch/projects/:id/instructions` |
| 成员重规划 | `POST /api/orch/projects/:id/replan` |

## 实现入口

- `packages/orchestrator/src/project-plan.ts`
- `packages/orchestrator/src/project.ts`
- 桌面镜像：`apps/renderer/src/features/projects/*`
- 单测：`packages/orchestrator/src/test/project.test.ts`（Plan / ChangeSet / replan merge）
