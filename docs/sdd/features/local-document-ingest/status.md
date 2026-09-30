# Local document ingest status

- Requirement: `LDI-001`
- Implementation: complete
- Automated verification: contracts/API/renderer type checks passed; agent-core 119/119 tests passed
- Converter smoke: MarkItDown DOCX/PDF conversion and Docling fallback conversion passed with the packaged runtime
- Package-size correction: Docling moved to an optional component; clean-runtime packaging implemented; packaged application acceptance pending
- Known boundary: no bundled OCR/VLM model; `.doc` is unsupported
