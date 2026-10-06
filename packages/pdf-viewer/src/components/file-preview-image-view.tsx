import { useEffect, useState } from 'react';
import type { FileViewProps } from '@/lib/file-preview-core';
import { cn } from '@/lib/utils';

/**
 * An image, fitted to the area; click for actual size.
 *
 * Loaded by `imageRenderer` — import that, not this, so the view stays out of the
 * bundle until an image is opened.
 */
export function ImageFileView({ file }: FileViewProps) {
  const [url, setUrl] = useState<string>();
  const [actual, setActual] = useState(false);

  // Created and revoked by one effect, so a file swapped underneath the view never
  // leaves its predecessor's blob pinned in memory.
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    setActual(false);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  if (!url) return null;

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 overflow-auto bg-muted/40',
        !actual && 'items-center justify-center p-4',
      )}
    >
      <button
        aria-label={actual ? 'Fit to view' : 'Show actual size'}
        aria-pressed={actual}
        className={cn(
          'shrink-0',
          actual ? 'm-auto cursor-zoom-out' : 'h-full w-full cursor-zoom-in',
        )}
        onClick={() => setActual((a) => !a)}
        type="button"
      >
        <img
          alt={file.name}
          className={cn(
            'max-w-none',
            !actual && 'h-full w-full object-contain',
          )}
          src={url}
        />
      </button>
    </div>
  );
}
