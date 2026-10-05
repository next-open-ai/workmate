# Requirements

## Functional

- DT-01: A conversation may own zero or more durable tasks and at most one active task.
- DT-02: Complex multi-step requests may create a task automatically; ordinary questions must remain lightweight.
- DT-03: “continue/resume” intent reuses the latest resumable task in the same conversation.
- DT-04: Each run remains isolated, while a bounded task working set is copied into the next run under `.task/`.
- DT-05: Every settled run creates a checkpoint, including failed or cancelled runs.
- DT-06: Task files record role, origin run, size and content hash; asset-library objects are referenced by immutable id.
- DT-07: Users and future clients can list, inspect, pause, resume and complete tasks through the orchestration API.
- DT-08: Deleting a conversation removes its task metadata and private task workspace.
- DT-09: When an uploaded-file request is classified as a durable task, original uploads are promoted into the task working set with the `source` role before execution begins.
- DT-10: Source promotion is content-addressed and idempotent; the same upload/content must not create duplicate working-set entries.
- DT-11: “Continue” on the task card must create a visible continuation message and a new run; “Pause” must cancel the active run instead of only changing metadata.
- DT-12: Changes made to restored files under `.task/` must be captured back into the working set without losing source-file provenance.
- DT-13: The platform and new digital employees default to a 30-minute wall-clock ceiling; durable-task attempts receive at least that budget, while other explicit employee timeout values remain supported. Timeout cancellation must not be reported as a user action.

## Non-functional

- DT-N01: No model credentials or absolute local paths are stored in public contracts.
- DT-N02: Materialization rejects traversal and symlink escapes and never overwrites the run's own files.
- DT-N03: Capture is bounded by file count and total bytes; excluded caches and dependencies are never copied.
- DT-N04: Orchestrator remains the single writer for durable-task state.
- DT-N05: Failure to persist a required task source must stop that run with a clear error instead of silently creating a non-resumable task.
