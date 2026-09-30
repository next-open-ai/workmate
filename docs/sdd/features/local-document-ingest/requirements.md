# Local document ingest requirements

Requirement ID: `LDI-001`

- A local LanceDB knowledge base accepts `.pdf` and `.docx` uploads in addition to text formats.
- Binary documents are parsed in the API/runtime process, never with browser `File.text()`.
- The base package uses the Node runtime (`unpdf`/PDF.js for PDF and direct OOXML extraction for DOCX), so ordinary document upload does not depend on a relocatable Python virtual environment. MarkItDown and Docling are optional enhanced converters; low-quality base output falls back to them when installed.
- The resulting Markdown enters the existing chunking, embedding, and LanceDB pipeline.
- Excel data-workbench import remains on SheetJS and is outside this change.
- Bailian binary upload behavior remains unchanged.
- Unsupported local binary formats fail with a readable error.

Requirement ID: `LDI-002`

- The import dialog clearly separates file upload from pasted text and supports click-to-select and drag-and-drop.
- A selected file is shown as ready in the application UI even though the native file input is reset to permit selecting the same file again.
- The dialog shows the workflow states: preparing content, parsing/vectorizing, success, and inline failure.
- Selecting a file only prepares it in renderer memory. The document is submitted to `/api/knowledge/ingest` only after the user clicks “Index”.
- The upload request accepts the Base64 expansion of an 8 MB cloud source file and must not be rejected by Fastify's default 1 MB body limit.
- The success state reports the generated chunk count for local indexing, or the cloud job identifier for asynchronous ingestion.
- Knowledge-base create/edit uses a blocking modal; clicking the backdrop or moving focus outside must not discard the form.

## Compatibility and rollback

The request contract already accepts `fileBase64`; its meaning is extended compatibly to local PDF/DOCX. Its maximum length is raised to accommodate the existing 8 MB source-file limit after Base64 expansion. Docling is installed into the user component directory and may be removed without affecting MarkItDown or existing indexed chunks.
