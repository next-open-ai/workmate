# Chat attachments requirements

- **ATT-R1** Chat input accepts PDF, DOCX, PPTX, PPSX, XLSX, XLS, CSV, HTML, Markdown, text, PNG, JPEG, WebP and common audio files.
- **ATT-R2** Attachments show upload/processing/ready/error states and can be removed before send.
- **ATT-R3** Chat uploads are temporary conversation data. They never enter assets, knowledge bases or the data workbench without an explicit user action.
- **ATT-R4** Enforce per-file, per-turn, per-session and global storage limits with actionable errors.
- **ATT-R5** PDF/DOCX, PPTX/PPSX and spreadsheet content is converted to bounded model context; original binaries are never embedded in chat JSON.
- **ATT-R6** Removing a conversation removes its temporary attachments. Expired unsent files are eligible for automatic cleanup.
- **ATT-R7** The composer presents one coherent, accessible attachment experience including drag/drop and clear privacy/storage guidance.
- **ATT-R8** Upload transport is binary, validates file signatures and constrains document/workbook complexity.
- **ATT-R9** Long documents select bounded, query-relevant chunks instead of blindly truncating only the beginning.
- **ATT-R10** PPTX/PPSX parsing is local and lightweight, preserves slide numbers and speaker notes, and selects whole relevant slides without adding an office runtime.
- **ATT-R11** Administrators can optionally install the PPTX enhanced parser into the user data directory. Uploads select it automatically when healthy and fall back to the lightweight parser on any failure; the base installer remains unchanged.
- **ATT-R12** HTML/HTM attachments are decoded locally without extra dependencies. Script, style and non-content markup is excluded before bounded text reaches the model.

## Limits

| Scope | Limit |
| --- | --- |
| One turn | 10 files, including at most 4 images and 1 audio; 50 MB total |
| Image | 10 MB |
| Audio | 25 MB |
| PDF | 20 MB |
| PPTX/PPSX | 25 MB; at most 3 per turn; at most 300 slides each |
| DOCX/XLSX/XLS/CSV | 10 MB |
| HTML/Markdown/text | 2 MB |
| Conversation | 50 files or 200 MB |
| Temporary store | 2 GB; warning at 80%, cleanup pressure at 95% |
