---
'@workspace/pdf-viewer': minor
---

Show a document's embedded files.

`Attachments` lists what a PDF carries inside itself, with the declared type and size,
the document's own description, an inline preview for text and XML, and a button to
save each one. A hybrid invoice — ZUGFeRD, Factur-X — is called out with a badge,
because the whole reason to surface attachments in a viewer is that someone reading
the PDF should know the machine-readable half is already in the file.

It renders **nothing** when a document embeds nothing, rather than an empty state every
other document scrolls past, so `Properties` carries it unconditionally and looks
exactly as it did for the documents that have none.
