# Local document ingest architecture

`KnowledgePage` reads text formats as UTF-8 and sends PDF/DOCX as Base64. The API validates the existing knowledge-ingest contract and delegates to `agent-core`.

`agent-core/document-parser.ts` performs base extraction in the packaged Node process: `unpdf` provides the serverless PDF.js text extractor and `fflate` reads DOCX OOXML. This path works after installation without launching the build machine's virtual environment. Only when an installed enhanced component is needed does it write a mode-0600 temporary input and invoke the optional Python parser. Temporary input is removed in `finally`, and a usable Node result remains available if enhancement fails.

MarkItDown and Docling's slim conversion core are installed together as an optional component from Settings into the user data directory. The enhanced parser adds that isolated directory to `PYTHONPATH` and uses the model-free native PDF pipeline when available. OCR, layout, Torch, ONNX file detection and VLM models remain outside the base installer. Packaging recreates and prunes the bundled virtual environment so removed dependencies, tests and bytecode caches cannot leak into later installers.
