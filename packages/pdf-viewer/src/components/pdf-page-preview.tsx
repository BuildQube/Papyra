import type { Document, RenderedPage } from '@build-qube/papyra';
import { useEffect, useState } from 'react';
import { PdfIsolationGuard } from '@/components/pdf-isolation-guard';
import { PageCanvas } from '@/components/pdf-page-canvas';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** Props for {@link PagePreview}. */
export interface PagePreviewProps {
  /** The open document. */
  doc: Document;
  /** Which page to show, 0-based. */
  page?: number;
  /**
   * Output width in pixels.
   *
   * Pixels rather than DPI, because page sizes vary by two orders of magnitude in
   * area: a fixed DPI that suits US Letter renders an ARCH-E drawing at a size that
   * can take the tab down.
   */
  width?: number;
  /**
   * Render priority. Higher yields to lower, so a wall of previews cannot starve
   * whatever the reader is actually looking at.
   */
  priority?: number;
  /** Classes for the rendered page. */
  className?: string;
}

/**
 * One page, rendered once, with nothing to interact with.
 *
 * For the places a PDF is a picture rather than a document — a card, a row in a list
 * of attachments, a thumbnail beside a filename.
 *
 * ```tsx
 * <PagePreview doc={doc} width={240} className="rounded-md border" />
 * ```
 */
export function PagePreview({
  doc,
  page = 0,
  width = 320,
  priority = 2,
  className,
}: PagePreviewProps) {
  const [bitmap, setBitmap] = useState<RenderedPage | null>(null);

  useEffect(() => {
    setBitmap(null);
    const job = doc.render(page, { fitWidth: width, priority });
    let cancelled = false;
    job.promise.then(
      (rendered) => !cancelled && setBitmap(rendered),
      () => {
        /* A preview that cannot render shows its placeholder and says nothing. */
      },
    );
    return () => {
      cancelled = true;
      job.cancel('preview replaced');
    };
  }, [doc, page, width, priority]);

  // The page's own aspect ratio, so the placeholder occupies exactly the space the
  // render will and nothing reflows when it arrives.
  const size = doc.pageSize(page);
  const ratio = `${size.width} / ${size.height}`;

  return (
    <PdfIsolationGuard>
      {bitmap ? (
        <PageCanvas
          className={cn('block h-auto w-full bg-white', className)}
          page={bitmap}
        />
      ) : (
        <Skeleton
          className={cn('w-full', className)}
          style={{ aspectRatio: ratio }}
        />
      )}
    </PdfIsolationGuard>
  );
}
