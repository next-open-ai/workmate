# Test specification

- Ordinary question does not create a task.
- Complex file task creates and activates one task.
- A settled run writes a checkpoint and captures safe workspace files.
- Continue intent reuses the active/latest resumable task and materializes its files.
- Traversal paths, symlinks, caches, dependency trees and oversized snapshots are rejected/skipped.
- Pause/resume/complete transitions are persisted and versioned.
- Cross-conversation task access is rejected by API ownership checks.
- Complex uploaded-file requests retain originals as `source` entries before the first run; ordinary uploaded-file Q&A does not.
- Reusing the same uploaded content is idempotent, while same-name different content receives a collision-safe path.
- Task-card Continue immediately submits a checkpoint-aware continuation turn and enters the normal busy state; Pause aborts the active run and persists `paused`.
