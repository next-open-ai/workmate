# Local document ingest architecture

`KnowledgePage` reads text formats as UTF-8 and sends PDF/DOCX as Base64. The API validates the existing knowledge-ingest contract and delegates to `agent-core`.

`agent-core/document-parser.ts` writes bytes to a mode-0600 temporary directory and invokes the packaged Python runtime module. The module tries MarkItDown first and falls back to Docling when the extracted content fails a small quality gate. Temporary input is removed in `finally`.

The base package contains MarkItDown. Docling's slim conversion core and PDF/DOCX format dependencies are an optional component installed from Settings into the user data directory. The parser adds that isolated directory to `PYTHONPATH` and uses the model-free native PDF pipeline when available. OCR, layout, Torch, and VLM models remain excluded. Packaging recreates the bundled virtual environment from scratch so removed or optional dependencies cannot leak into later installers.
