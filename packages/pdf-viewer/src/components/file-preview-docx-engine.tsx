import { lazy, Suspense } from 'react';
import type { OfficeFileViewOptions } from '@/components/file-preview-office-view';
import { Spinner } from '@/components/ui/spinner';
import type { FileViewProps } from '@/lib/file-preview-core';

/** What a preview may set for its Word documents. */
export interface DocxFileViewOptions extends OfficeFileViewOptions {
  /**
   * `'html'`, the default, flows the document as HTML through `docx-preview`: small
   * (about 55 KB) and approximate. `'papyra'` paginates and draws it in Rust over
   * WordCraft, as Word would print it — page breaks, headers and footers where Word
   * puts them — at the cost of a separate wasm module of about 4 MB. Experimental.
   * `fonts` applies only to `'papyra'`.
   */
  engine?: 'html' | 'papyra';
}

// Each engine is its own chunk, so choosing one never downloads the other.
const Html = lazy(() =>
  import('./file-preview-docx-view').then((m) => ({ default: m.DocxFileView })),
);
const Papyra = lazy(() =>
  import('./file-preview-office-view').then((m) => ({
    default: m.OfficeFileView,
  })),
);

/** Picks the Word engine from `options.engine`. Loaded by `docxRenderer`. */
export function DocxEngineView({
  options,
  ...rest
}: FileViewProps<DocxFileViewOptions>) {
  const { engine, fonts } = options;
  return (
    <Suspense
      fallback={
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      }
    >
      {engine === 'papyra' ? (
        <Papyra {...rest} options={{ fonts }} />
      ) : (
        <Html {...rest} options={{}} />
      )}
    </Suspense>
  );
}
