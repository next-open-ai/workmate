# Chat attachments test specification

- **ATT-TEST-1** Contract rejects unsupported type, oversized metadata and more than ten files. Traces ATT-R1/R4.
- **ATT-TEST-2** Text/Markdown and workbook parsing produces bounded context and safe metadata. Traces ATT-R5.
- **ATT-TEST-3** A sent turn preserves attachment metadata and exposes extracted context only to model messages. Traces ATT-R3/R5.
- **ATT-TEST-4** Conversation deletion removes temporary attachment storage. Traces ATT-R6.
- **ATT-TEST-5** Composer supports selection, drag/drop, removal, upload failure and limit messaging. Traces ATT-R2/R7.
- **ATT-TEST-6** A minimal PPTX upload extracts ordered slide text and relationship-linked speaker notes, returns slide counts, participates in a sent turn and is removed with the conversation. Traces ATT-R1/R5/R6/R8/R10.
- **ATT-TEST-7** PPTX enhanced parsing remains disabled without its component marker, becomes discoverable after installation, and never removes the lightweight fallback. Traces ATT-R11.
- **ATT-TEST-8** HTML upload preserves title and readable body text while excluding script/style content; TXT remains accepted through the direct text path. Traces ATT-R1/R5/R8/R12.
