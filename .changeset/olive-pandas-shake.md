---
'@build-qube/papyra-native': minor
'@build-qube/papyra': minor
---

Read the files a PDF embeds.

- `doc.attachments()` lists them — `name`, `description`, `mediaType`, `size`,
  `created`, `modified` and `relationship` — in the order the document files them, and
  resolves to an empty array when there are none, which is the common case. Memoised,
  off the event loop.
- `doc.attachmentData(index)` decompresses one, by its `Attachment.index`. Split from
  the list on purpose: an embedded file is as large as it is, and listing what a
  document carries is not a reason to decompress all of it.
- `attachmentMediaType(file)` falls back to the filename's extension, since most
  documents declare no `/Subtype`, and to `application/octet-stream` when neither
  answers.
- `isInvoiceAttachment(file)` recognises the hybrid-invoice payloads — ZUGFeRD,
  Factur-X, Order-X, XRechnung. Those PDFs are the same invoice twice over, one half
  for a person and one for an accounting system, and a reader that never mentions the
  XML leaves someone retyping figures the file already carries. Matched on the
  standardised filename rather than `relationship` alone, which producers get wrong
  often enough to miss real invoices.

Two things worth knowing. `size` is `/Params /Size` — the document's claim, not a
measurement, because measuring means decompressing. And `name` prefers `/UF` over `/F`
over the name the file was filed under, which is the order the spec asks for.
