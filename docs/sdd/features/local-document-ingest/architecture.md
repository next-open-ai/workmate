# Local document ingest architecture

`KnowledgePage` reads text formats as UTF-8 and sends PDF/DOCX as Base64. The API validates the existing knowledge-ingest contract and delegates to `agent-core`.

`agent-core/document-parser.ts` writes bytes to a mode-0600 temporary directory and invokes the packaged Python runtime module. The module tries MarkItDown first and falls back to Docling when the extracted content fails a small quality gate. Temporary input is removed in `finally`.

Only Docling's slim conversion core and PDF/DOCX format dependencies are packaged. PDF fallback uses the model-free native pipeline. OCR, layout, Torch, and VLM models are deliberately excluded from the first release to keep the desktop bundle bounded and prevent first-use downloads.
