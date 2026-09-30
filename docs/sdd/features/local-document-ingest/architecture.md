# Local document ingest architecture

`KnowledgePage` reads text formats as UTF-8 and sends PDF/DOCX as Base64. The API validates the existing knowledge-ingest contract and delegates to `agent-core`.

`agent-core/document-parser.ts` writes bytes to a mode-0600 temporary directory and invokes the packaged Python runtime module. When the optional component exists, the module tries MarkItDown first. Otherwise it uses the built-in PDF/DOCX readers, and low-quality output may fall back to Docling when that component is available. Temporary input is removed in `finally`.

The base package reads PDF with AgentScope's existing `pypdf` dependency and DOCX directly from OOXML with Python's standard library. MarkItDown and Docling's slim conversion core are installed together as an optional component from Settings into the user data directory. The parser adds that isolated directory to `PYTHONPATH` and uses the model-free native PDF pipeline when available. OCR, layout, Torch, ONNX file detection and VLM models remain outside the base installer. Packaging recreates and prunes the bundled virtual environment so removed dependencies, tests and bytecode caches cannot leak into later installers.
