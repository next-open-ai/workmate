"""Convert local office documents to Markdown for Workmate knowledge ingest."""

from __future__ import annotations

import json
from pathlib import Path
import sys


def _usable(text: str) -> bool:
    compact = " ".join(text.split())
    return len(compact) >= 80 and compact.count("\ufffd") / max(1, len(compact)) < 0.02


def _markitdown(source: Path) -> str:
    from markitdown import MarkItDown

    result = MarkItDown().convert(str(source))
    return str(result.text_content or "").strip()


def _docling(source: Path) -> str:
    from docling.datamodel.base_models import InputFormat
    from docling.document_converter import DocumentConverter, NativePdfFormatOption

    # NativePdfFormatOption is model-free: packaged desktop builds do not pull
    # Torch/layout/OCR models at first use. DOCX keeps Docling's simple backend.
    converter = DocumentConverter(
        format_options={InputFormat.PDF: NativePdfFormatOption()}
    )
    result = converter.convert(str(source))
    return str(result.document.export_to_markdown() or "").strip()


def parse(source: Path) -> dict[str, object]:
    warnings: list[str] = []
    markdown = ""
    try:
        markdown = _markitdown(source)
    except Exception as exc:  # provider errors are returned as a concise diagnostic
        warnings.append(f"MarkItDown failed: {exc}")

    if source.suffix.lower() in {".pptx", ".ppsx"}:
        if not markdown:
            raise RuntimeError("; ".join(warnings) or "No readable presentation content was found.")
        return {"markdown": markdown, "parser": "markitdown", "warnings": warnings}

    # DOCX is normally handled well by MarkItDown. PDF falls back when the
    # result is empty/garbled; Docling also serves as the general fallback.
    if not _usable(markdown):
        try:
            docling_markdown = _docling(source)
            if _usable(docling_markdown) or not markdown:
                return {"markdown": docling_markdown, "parser": "docling", "warnings": warnings}
        except Exception as exc:
            warnings.append(f"Docling failed: {exc}")

    if not markdown:
        raise RuntimeError("; ".join(warnings) or "No readable document content was found.")
    return {"markdown": markdown, "parser": "markitdown", "warnings": warnings}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: document_parser.py <file>")
    print(json.dumps(parse(Path(sys.argv[1]).resolve()), ensure_ascii=False))


if __name__ == "__main__":
    main()
