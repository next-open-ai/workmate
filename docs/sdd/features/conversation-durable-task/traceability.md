# Traceability

| Requirement | Implementation | Verification |
|---|---|---|
| DT-01, DT-07 | `packages/orchestrator/src/durable-task.ts`, API routes | durable-task unit tests |
| DT-02, DT-03 | chat task classifier/selection | chat integration tests |
| DT-04, DT-N02, DT-N03 | workspace capture/materialization | filesystem safety tests |
| DT-05 | chat settle hook | chat integration tests |
| DT-06 | contracts + task service | schema/unit tests |
| DT-08 | chat deletion hook | deletion test |
| DT-09, DT-10, DT-N05 | source resolver + `addSourceFile` | source promotion tests |
| DT-11 | `ChatWorkspace` task-card actions | renderer typecheck/build + interaction regression |
| DT-N01, DT-N04 | contracts/orchestrator ownership | typecheck + API tests |
