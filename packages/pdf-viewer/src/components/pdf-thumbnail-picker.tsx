import type { Document } from '@build-qube/papyra';
import { useState } from 'react';
import { PdfIsolationGuard } from '@/components/pdf-isolation-guard';
import { Thumbnails } from '@/components/pdf-thumbnails';
import { cn } from '@/lib/utils';

/** Props for {@link ThumbnailPicker}. */
export interface ThumbnailPickerProps {
  /** The open document. */
  doc: Document;
  /** The selected page, 0-based. Leave it out to let the picker hold its own. */
  value?: number;
  /** The page to start on when uncontrolled. */
  defaultValue?: number;
  /** Called with the chosen page, 0-based. */
  onChange?: (page: number) => void;
  /** Tiles per row. */
  columns?: number;
  /** Classes for the scrolling container. */
  className?: string;
}

/**
 * Pick a page out of a document.
 *
 * For choosing a cover, a page to extract, or the one to attach — the cases where a
 * PDF is something to select from rather than to read. Thumbnails stream in as they
 * finish rather than appearing all at once, and they yield to anything else being
 * rendered.
 *
 * Controlled or not: pass `value` and `onChange` to own the selection, or neither and
 * it keeps its own.
 *
 * ```tsx
 * <ThumbnailPicker doc={doc} columns={3} onChange={setCoverPage} />
 * ```
 */
export function ThumbnailPicker({
  doc,
  value,
  defaultValue = 0,
  onChange,
  columns = 3,
  className,
}: ThumbnailPickerProps) {
  const [own, setOwn] = useState(defaultValue);
  const selected = value ?? own;

  return (
    <PdfIsolationGuard>
      <Thumbnails
        className={cn('overflow-y-auto', className)}
        columns={columns}
        current={selected}
        doc={doc}
        onSelect={(page) => {
          // Track internally even when controlled, so a caller that ignores the
          // change and passes no `value` still sees the selection move.
          setOwn(page);
          onChange?.(page);
        }}
      />
    </PdfIsolationGuard>
  );
}
