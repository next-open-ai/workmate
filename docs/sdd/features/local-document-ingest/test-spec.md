# Local document ingest test specification

| Test | Requirement | Expected result |
| --- | --- | --- |
| Supported extension classification | LDI-001 | PDF/DOCX accepted; legacy/unknown formats rejected |
| Markdown quality gate | LDI-001 | Empty, short, and replacement-heavy output rejected |
| Runtime protocol | LDI-001 | Isolated converter returns structured Markdown to Node |
| Type checks | LDI-001 | contracts, agent-core, API, and renderer compile |
| File selection state | LDI-002 | Selected file name, size, and ready state remain visible; no ingest request is sent before submission |
| Ingest state feedback | LDI-002 | Processing, success, and server failure are visible within the dialog |
| Upload size boundary | LDI-002 | An 8 MB source file fits the Base64 request contract and the API route body limit |
| Renderer type check/build | LDI-002 | The professional import dialog compiles and bundles successfully |
| Knowledge-base form modality | LDI-002 | Clicking the backdrop does not close or reset the create/edit form; only explicit Close or Save exits it |
| Optional Docling lifecycle | LDI-001 | Admin can install, validate and remove Docling in the user component directory; base parsing remains available |
| Reproducible runtime packaging | LDI-002 | Packaging starts from a clean virtual environment and does not retain dependencies removed from base requirements |

Manual packaged-app acceptance: import one text PDF and one DOCX into a local knowledge base, then retrieve a distinctive sentence from each. A scanned PDF without embedded text may report no readable content until the optional OCR phase is added.
