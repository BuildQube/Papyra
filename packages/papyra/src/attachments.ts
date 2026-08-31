import type { Attachment as NativeAttachment } from '@build-qube/papyra-native';

/**
 * A file embedded in the document.
 *
 * Metadata only. The bytes come from {@link Document.attachmentData}, because listing
 * what a document carries is a different question from opening one of the things it
 * carries, and an embedded file is as large as it is.
 */
export interface Attachment {
  /** Position in {@link Document.attachments}, and what identifies it for a fetch. */
  readonly index: number;
  /**
   * The name to save the file under.
   *
   * `/UF` where the document provides it — the Unicode spelling, and the one the spec
   * tells a reader to prefer — falling back to `/F`, then to the name the file was
   * filed under. Never empty.
   */
  readonly name: string;
  /** The document's own description of what the file is for. */
  readonly description: string | null;
  /**
   * The declared media type, e.g. `'application/xml'`.
   *
   * Absent more often than not, so fall back to the extension on {@link name} rather
   * than treating this as the answer. {@link attachmentMediaType} does exactly that.
   */
  readonly mediaType: string | null;
  /**
   * Length in bytes, uncompressed, **as the document claims it**.
   *
   * Not a measurement: reading the true length means decompressing the stream, which
   * is the work this type exists to defer. Fine for a size column; not something to
   * allocate against.
   */
  readonly size: number | null;
  /** Creation date, ISO 8601. */
  readonly created: string | null;
  /** Modification date, ISO 8601. */
  readonly modified: string | null;
  /**
   * What the file is to the document: `'Source'`, `'Data'`, `'Alternative'`,
   * `'Supplement'`, `'EncryptedPayload'` or `'Unspecified'`.
   *
   * This is what identifies a hybrid invoice. A ZUGFeRD or Factur-X PDF carries its
   * XML with a relationship of `Alternative` or `Data`, and that is the difference
   * between a machine-readable invoice and a PDF with a file stapled to it — see
   * {@link isInvoiceAttachment}.
   */
  readonly relationship: string | null;
}

/** @internal */
export function toAttachment(
  native: NativeAttachment,
  index: number,
): Attachment {
  return {
    index,
    name: native.name,
    description: native.description ?? null,
    mediaType: native.mediaType ?? null,
    size: native.size ?? null,
    created: native.created ?? null,
    modified: native.modified ?? null,
    relationship: native.relationship ?? null,
  };
}

/** Extension to media type, for the majority of files that declare none. */
const BY_EXTENSION: Record<string, string> = {
  csv: 'text/csv',
  html: 'text/html',
  json: 'application/json',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  xml: 'application/xml',
  zip: 'application/zip',
};

/**
 * The attachment's media type, falling back to its extension.
 *
 * `'application/octet-stream'` when neither answers, which is the honest default for
 * bytes nothing describes — and the one a download will not misrender.
 */
export function attachmentMediaType(file: Attachment): string {
  if (file.mediaType) return file.mediaType;
  const dot = file.name.lastIndexOf('.');
  const extension = dot < 0 ? '' : file.name.slice(dot + 1).toLowerCase();
  return BY_EXTENSION[extension] ?? 'application/octet-stream';
}

/** The filenames the hybrid-invoice standards define, lowercased. */
const INVOICE_NAMES = new Set([
  'factur-x.xml',
  'zugferd-invoice.xml',
  'xrechnung.xml',
  'order-x.xml',
]);

/**
 * Whether this attachment is the machine-readable half of a hybrid invoice.
 *
 * ZUGFeRD, Factur-X, Order-X and XRechnung all work the same way: the PDF is what a
 * person reads, and an embedded XML file is what an accounting system reads. Both
 * halves are the same invoice, and a consumer that ignores the XML is retyping data
 * the document already carries.
 *
 * Matched on the standardised filename rather than on
 * {@link Attachment.relationship} alone. The relationship narrows it — the standards
 * require `Alternative` or `Data` — but producers get it wrong often enough that
 * requiring it would miss real invoices, while the filenames are fixed by the
 * specifications and are what every other implementation keys on.
 */
export function isInvoiceAttachment(file: Attachment): boolean {
  return INVOICE_NAMES.has(file.name.toLowerCase());
}
