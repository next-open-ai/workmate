# Chat attachments status

Implemented the first complete local attachment lifecycle: contracts, temporary storage, parsing, model context, composer UI, message display, quota enforcement, expiry cleanup and settings management.

PPTX/PPSX first slice is complete: lightweight OOXML parsing extracts ordered slide text and relationship-linked speaker notes, query-time selection keeps whole relevant slides, the composer accepts up to three presentations per turn, and originals can use the existing explicit asset-promotion flow. This reuses the existing `fflate` dependency and does not bundle LibreOffice, PowerPoint automation or a Python presentation runtime.

An optional PPTX enhanced component is now available under Settings → General. Administrators can install, repair or remove it without changing the base package. Healthy installations are selected automatically for PPTX/PPSX uploads, while all failures preserve the lightweight parser fallback.

HTML/HTM now shares the lightweight text attachment path with Markdown/TXT. The server extracts bounded readable body content, preserves the page title, and excludes script/style content without adding a parser dependency.

Validation:

- `pnpm typecheck` — passed across all 11 workspace projects.
- `pnpm test` — passed: channel 4 tests, agent-core 127 tests and orchestrator 44 tests (175 total).
- `pnpm build` — passed across the complete workspace; renderer emitted existing dynamic-import and chunk-size advisory warnings only.
- `pnpm chat-attachments:regression` — real HTTP binary upload, message send, hidden-context boundary, asset promotion and conversation cleanup passed.
- PPTX regression additionally verifies page order, extracted text and relationship-linked speaker notes.
- PPTX follow-up API and renderer typechecks passed; API and renderer production builds passed. API bundle remained 13.03 MB; the renderer entry changed by roughly 0.4 KB from the immediately preceding build.
- Optional enhanced-component follow-up: agent-core, API and renderer typechecks passed; agent-core 128 tests passed; API/renderer production builds passed; the real chat attachment regression passed. The API bundle is 13.04 MB and no presentation dependency was added to the base package manifest.
- HTML/TXT follow-up: API and renderer typechecks passed; real HTTP regression verified HTML title/body extraction, script/style removal, message persistence and cleanup. API bundle remains 13.04 MB.
- `pnpm size:check` remains red on the repository's existing 1.50 MB renderer budget (current assets 4.59 MB); the PPTX implementation did not introduce a heavyweight runtime.
- `git diff --check` — passed.
- Windows packaged-app acceptance remains a release gate because this workspace is macOS.
