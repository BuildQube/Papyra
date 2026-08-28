import type { Document } from '@build-qube/papyra';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components/dialog';
import { cn } from '@workspace/ui/lib/utils';

interface Props {
  doc: Document;
  name: string;
  /** The file's own length, which no amount of parsing recovers. */
  byteLength: number;
  /** Which page to describe the dimensions of — they vary within a document. */
  page: number;
  onClose: () => void;
}

/**
 * Document properties, as every viewer shows them.
 *
 * This was a native `<dialog>` on `showModal`, for focus trapping, Escape, inertness
 * of the page behind it and the top layer. Base UI's Dialog gives the first three and
 * is what the rest of this app is built from; only the top layer is traded away, and
 * nothing here competes for a stacking context.
 *
 * `doc.metadata` is synchronous — the engine reads the information dictionary while
 * loading — so there is no pending state to design around.
 */
export function Properties({ doc, name, byteLength, page, onClose }: Props) {
  const { metadata } = doc;
  const size = doc.pageSize(page);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Document properties</DialogTitle>
        </DialogHeader>

        {/* The label column sizes to its widest entry; the value takes the rest. */}
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-5 gap-y-2">
          <Row label="File name" value={name} />
          <Row label="File size" value={fileSize(byteLength)} />

          <Row label="Title" value={metadata.title} />
          <Row label="Author" value={metadata.author} />
          <Row label="Subject" value={metadata.subject} />
          <Row label="Keywords" value={metadata.keywords} />

          <Row label="Created" value={date(metadata.created)} />
          <Row label="Modified" value={date(metadata.modified)} />
          <Row label="Creator" value={metadata.creator} />
          <Row label="PDF Producer" value={metadata.producer} />

          <Row label="PDF version" value={doc.pdfVersion} />
          <Row label="Page count" value={String(doc.pageCount)} />
          <Row label={`Page size (page ${page + 1})`} value={pageSize(size)} />
          <Row label="Fingerprint" value={doc.fingerprint} mono />
        </dl>

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('wrap-anywhere', mono && 'font-mono text-xs')}>
        {value ?? '—'}
      </dd>
    </>
  );
}

/** `992 KB (1,016,315 bytes)` — the round number to read, the exact one to quote. */
function fileSize(bytes: number): string {
  const kb = bytes / 1024;
  const rounded =
    kb < 1024
      ? `${Math.round(kb).toLocaleString()} KB`
      : `${(kb / 1024).toFixed(1)} MB`;
  return `${rounded} (${bytes.toLocaleString()} bytes)`;
}

function date(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleString();
}

/**
 * Common paper sizes, in millimetres, portrait.
 *
 * Matched with a tolerance because producers write 611.976 points for A4's 210mm and
 * every rounding on the way there is a fraction of a millimetre out.
 */
const PAPERS: readonly [number, number, string][] = [
  [210, 297, 'A4'],
  [297, 420, 'A3'],
  [420, 594, 'A2'],
  [594, 841, 'A1'],
  [841, 1189, 'A0'],
  [148, 210, 'A5'],
  [105, 148, 'A6'],
  [216, 279, 'Letter'],
  [216, 356, 'Legal'],
  [279, 432, 'Tabloid'],
  [184, 267, 'Executive'],
  [457, 610, 'ARCH B'],
  [610, 914, 'ARCH D'],
  [762, 1067, 'ARCH E'],
];

/** `8.5 × 11 in (Letter, portrait)`. */
function pageSize({
  width,
  height,
}: {
  width: number;
  height: number;
}): string {
  const inches = `${trim(width / 72)} × ${trim(height / 72)} in`;
  const orientation = width > height ? 'landscape' : 'portrait';

  const mm = [width, height].map((pt) => (pt * 25.4) / 72);
  const [short, long] = [Math.min(...mm), Math.max(...mm)];
  const paper = PAPERS.find(
    ([w, h]) => Math.abs(short - w) <= 1.5 && Math.abs(long - h) <= 1.5,
  );

  return `${inches} (${paper ? `${paper[2]}, ` : ''}${orientation})`;
}

/** Two decimals at most, and no trailing zeroes: `8.5`, not `8.50`. */
function trim(value: number): string {
  return String(Math.round(value * 100) / 100);
}
