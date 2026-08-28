import type { Document } from '@build-qube/papyra';
import { useEffect, useRef } from 'react';

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
 * A native `<dialog>` opened with `showModal`, so focus trapping, Escape, inertness
 * of the page behind it and the top layer all come from the platform rather than from
 * a hand-rolled modal that gets one of them wrong.
 *
 * `doc.metadata` is synchronous — the engine reads the information dictionary while
 * loading — so there is no pending state to design around.
 */
export function Properties({ doc, name, byteLength, page, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { metadata } = doc;
  const size = doc.pageSize(page);

  useEffect(() => {
    const el = dialog.current;
    if (!el || el.open) return;
    el.showModal();

    // Dismiss on a backdrop click. A click on the backdrop lands on the dialog
    // element itself; anything inside it reports a different target. Bound here
    // rather than as an `onClick` prop because on the element it is a click with no
    // keyboard equivalent — Escape, which `showModal` already handles, is the
    // keyboard path, and a JSX handler would only look like it needed a second one.
    const dismiss = (e: MouseEvent) => {
      if (e.target === el) el.close();
    };
    el.addEventListener('click', dismiss);
    return () => el.removeEventListener('click', dismiss);
  }, []);

  return (
    <dialog ref={dialog} className="properties" onClose={onClose}>
      <h2>Document properties</h2>

      <dl>
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

      <form method="dialog">
        <button type="submit">Close</button>
      </form>
    </dialog>
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
      <dt>{label}</dt>
      {/* An em dash, not an empty cell: "the document did not say" is information. */}
      <dd className={mono ? 'mono' : undefined}>{value ?? '—'}</dd>
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
  // A PDF date is self-reported and can be nonsense; show what was written rather
  // than "Invalid Date".
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
