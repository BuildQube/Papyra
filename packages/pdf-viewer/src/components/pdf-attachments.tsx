import type { Attachment, Document } from '@build-qube/papyra';
import { attachmentMediaType, isInvoiceAttachment } from '@build-qube/papyra';
import { DownloadIcon, FileTextIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/** Props for {@link Attachments}. */
export interface AttachmentsProps {
  /** The open document. */
  doc: Document;
  /** Classes for the wrapper. */
  className?: string;
}

/** Media types worth showing inline rather than only offering to save. */
const PREVIEWABLE = /^(text\/|application\/(xml|json|x-yaml)$)/;

/** How much of a file to decode for a preview. */
const PREVIEW_LIMIT = 16 * 1024;

/**
 * The files a document carries inside itself.
 *
 * Renders nothing at all when there are none, which is the common case — this is a
 * section that appears only for documents that have one, rather than an empty state
 * every other document has to scroll past.
 *
 * A hybrid invoice is called out by name. ZUGFeRD and Factur-X put the machine-readable
 * half of the invoice in here, and the whole point of showing attachments in a viewer
 * is that someone reading the PDF should know the data is already in the file.
 */
export function Attachments({ doc, className }: AttachmentsProps) {
  const [files, setFiles] = useState<readonly Attachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setFiles(null);
    setError(null);
    doc.attachments().then(
      (found) => !cancelled && setFiles(found),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [doc]);

  if (error) {
    return (
      <p className="flex items-center gap-2 text-xs text-destructive">
        <TriangleAlertIcon className="size-3.5" />
        The attachments could not be read: {error}
      </p>
    );
  }
  // Nothing to say yet, and nothing to say ever, look the same on purpose.
  if (!files || files.length === 0) return null;

  return (
    // `min-w-0` all the way down: a flex item defaults to `min-width: auto`, which
    // lets the preview's long lines widen the dialog instead of scrolling inside it.
    <section className={cn('flex min-w-0 flex-col gap-2', className)}>
      <h3 className="font-medium text-sm">
        Attachments
        <span className="ml-1.5 font-normal text-muted-foreground">
          {files.length}
        </span>
      </h3>
      <ul className="flex min-w-0 flex-col gap-1.5">
        {files.map((file) => (
          <AttachmentRow key={file.index} doc={doc} file={file} />
        ))}
      </ul>
    </section>
  );
}

function AttachmentRow({ doc, file }: { doc: Document; file: Attachment }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const type = attachmentMediaType(file);

  async function bytes(): Promise<Uint8Array> {
    setBusy(true);
    setFailed(null);
    try {
      return await doc.attachmentData(file.index);
    } finally {
      setBusy(false);
    }
  }

  async function show() {
    if (preview !== null) {
      setPreview(null);
      return;
    }
    try {
      const data = await bytes();
      setPreview(
        new TextDecoder().decode(data.subarray(0, PREVIEW_LIMIT)) +
          (data.byteLength > PREVIEW_LIMIT ? '\n…' : ''),
      );
    } catch (e) {
      setFailed((e as Error).message);
    }
  }

  async function save() {
    try {
      const data = await bytes();
      // A fresh copy: the bytes come from wasm memory as a view, and the Blob has to
      // outlive whatever the engine does with that buffer next.
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(data)], { type }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setFailed((e as Error).message);
    }
  }

  return (
    <li className="min-w-0 rounded-md border px-2.5 py-2">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate font-medium text-sm">
          {file.name}
        </span>
        {isInvoiceAttachment(file) && (
          <Badge variant="secondary" className="flex-none">
            e-invoice
          </Badge>
        )}
        {PREVIEWABLE.test(type) && (
          <Button
            variant="ghost"
            size="xs"
            onClick={show}
            aria-label={preview === null ? 'Show contents' : 'Hide contents'}
          >
            <FileTextIcon />
          </Button>
        )}
        <Button
          variant="ghost"
          size="xs"
          onClick={save}
          disabled={busy}
          aria-label={`Save ${file.name}`}
        >
          {busy ? <Spinner className="size-3" /> : <DownloadIcon />}
        </Button>
      </div>

      <p className="flex flex-wrap items-baseline gap-x-2 text-muted-foreground text-xs">
        <span className="font-mono">{type}</span>
        {file.size !== null && <span>{byteSize(file.size)}</span>}
        {/* `Unspecified` is the default and says nothing worth the space. */}
        {file.relationship && file.relationship !== 'Unspecified' && (
          <span>{file.relationship}</span>
        )}
        {file.description && (
          <span className="w-full truncate">{file.description}</span>
        )}
      </p>

      {failed && (
        <p className="mt-1 text-destructive text-xs">
          Could not read this file: {failed}
        </p>
      )}
      {preview !== null && (
        <pre className="mt-2 max-h-48 max-w-full overflow-auto rounded bg-muted p-2 text-[11px] leading-relaxed">
          {preview}
        </pre>
      )}
    </li>
  );
}

/** `1.3 KB` — the declared size, rounded to something worth reading. */
function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}
