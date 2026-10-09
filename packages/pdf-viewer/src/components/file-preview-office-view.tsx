import {
  addOfficeFont,
  type OfficeDocument,
  openOffice,
} from '@build-qube/papyra/office';
import {
  type Rotation,
  rotateSize,
  type SearchMatch,
} from '@build-qube/papyra/view';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ContinuousPages } from '@/components/pdf-continuous-pages';
import { PdfIsolationGuard } from '@/components/pdf-isolation-guard';
import { Spinner } from '@/components/ui/spinner';
import { ZoomBar } from '@/components/viewer-zoom-bar';
import { useZoom, type ZoomAnchor } from '@/hooks/use-viewer-zoom';
import type { FileViewProps } from '@/lib/file-preview-core';
import type { Size } from '@/lib/viewer-zoom';

/** Padding inside the scroll area, which content cannot use when fitting. */
const GUTTER = 48;

/** What a preview may set for its Word documents and decks. */
export interface OfficeFileViewOptions {
  /**
   * TrueType or OpenType font URLs, registered with the engines before the first
   * file is opened.
   *
   * This is what decides whether a document paginates like Word. A browser has no
   * system fonts, so a document set in Calibri is otherwise laid out in Source Sans,
   * whose different widths move every line break after the first. Carlito, Caladea,
   * Arimo and Tinos are metric-compatible with Calibri, Cambria, Arial and Times New
   * Roman, and both engines look for them by name. A font registered after a file is
   * open does not change that file's layout.
   */
  fonts?: readonly string[];
}

/** Each URL fetched once per page load, whichever preview asks first. */
const registered = new Map<string, Promise<void>>();

function registerFonts(urls: readonly string[]): Promise<void> {
  return Promise.all(
    urls.map((url) => {
      let done = registered.get(url);
      if (!done) {
        // A font that fails to load costs fidelity, not the preview: the engines
        // fall back to what they have.
        done = fetch(url)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
          .then((b) => addOfficeFont(new Uint8Array(b)))
          .then(
            () => undefined,
            (e: unknown) => console.warn(`papyra: font ${url} not loaded`, e),
          );
        registered.set(url, done);
      }
      return done;
    }),
  ).then(() => undefined);
}

type Opened =
  | { status: 'opening' }
  | { status: 'open'; doc: OfficeDocument }
  | { status: 'failed'; error: unknown };

/**
 * A Word document or PowerPoint deck, laid out and drawn by papyra in Rust —
 * WordCraft for Word, DeckCraft for slides — in the PDF viewer's continuous column.
 *
 * Unlike `docx-preview` this is a real pagination: page breaks, headers and footers
 * land where Word puts them, given the fonts (see {@link OfficeFileViewOptions.fonts}).
 * Experimental, as the engines are.
 *
 * Loaded by `pptxRenderer`, and by `docxRenderer` with `engine: 'papyra'` — import
 * those, not this, so papyra stays out of the bundle until a file is opened.
 */
export function OfficeFileView({
  file,
  options,
}: FileViewProps<OfficeFileViewOptions>) {
  return (
    <PdfIsolationGuard>
      <OpenedOffice file={file} fonts={options.fonts} />
    </PdfIsolationGuard>
  );
}

function OpenedOffice({
  file,
  fonts,
}: Pick<FileViewProps, 'file'> & { fonts?: readonly string[] }) {
  const [opened, setOpened] = useState<Opened>({ status: 'opening' });
  // Joined so that a new array with the same URLs, as an inline `options` object
  // makes on every render, does not reopen the file.
  const fontKey = (fonts ?? []).join('\n');

  useEffect(() => {
    let live = true;
    setOpened({ status: 'opening' });
    registerFonts(fontKey ? fontKey.split('\n') : [])
      .then(() => openOffice(file))
      .then(
        (doc) => live && setOpened({ status: 'open', doc }),
        (error: unknown) => live && setOpened({ status: 'failed', error }),
      );
    return () => {
      live = false;
    };
  }, [file, fontKey]);

  switch (opened.status) {
    case 'opening':
      return (
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      );
    case 'failed':
      // To the preview's error boundary, which says the file could not be opened and
      // offers it as a download.
      throw opened.error;
    case 'open':
      return <OfficePages doc={opened.doc} />;
  }
}

/** No search for office documents yet, so every page draws no matches. */
const NO_MATCHES: readonly SearchMatch[] = [];

/**
 * Every page in one scrolling column, as the PDF viewer shows them, with its zoom
 * bar: fit modes, pinch and wheel zoom, rotation, and a page box that follows the
 * scroll. The column is the PDF one, unchanged — an office document is a
 * `PageSource`, so only the pages in and near the viewport are rendered, and the
 * queue is reprioritised as they scroll by.
 */
function OfficePages({ doc }: { doc: OfficeDocument }) {
  const viewport = useRef<HTMLDivElement>(null);
  const anchor = useRef<ZoomAnchor | null>(null);
  const [page, setPage] = useState(0);
  const [rotation, setRotation] = useState<Rotation>(0);

  // Fit modes measure the page as shown, so a turned portrait page fits by height.
  const shown: Size = useMemo(
    () => rotateSize(doc.pageSize(page), rotation),
    [doc, page, rotation],
  );
  const zoom = useZoom({
    viewport,
    page: shown,
    gutter: GUTTER,
    // A deck is read a slide at a time; a document is read down the column.
    initial: doc.kind === 'slides' ? 'page-fit' : 'page-width',
    // The column anchors zoom itself: the gaps between pages do not scale with the
    // pages, so the point under the cursor cannot be derived from the DOM.
    anchor,
  });

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col @container/pdf-viewer">
      <div className="flex flex-none flex-wrap items-center gap-2.5 border-b bg-card px-3 py-1.5">
        <ZoomBar
          onPage={setPage}
          onSpec={zoom.setSpec}
          onStepIn={zoom.stepIn}
          onStepOut={zoom.stepOut}
          page={page}
          pageCount={doc.pageCount}
          rotation={rotation}
          onRotate={(quarters) =>
            setRotation(
              ((((rotation + quarters * 90) % 360) + 360) % 360) as Rotation,
            )
          }
          scale={zoom.scale}
          settling={zoom.settling}
          spec={zoom.spec}
          subject={doc.kind === 'slides' ? 'Slide' : 'Page'}
        />
      </div>
      <div
        className="relative grid min-h-0 flex-1 touch-pan-x touch-pan-y items-start justify-items-center overflow-auto overscroll-contain bg-muted/40 p-6 outline-none"
        ref={viewport}
        tabIndex={-1}
      >
        <ContinuousPages
          active={null}
          anchor={anchor}
          doc={doc}
          matches={NO_MATCHES}
          onPage={setPage}
          page={page}
          renderScale={zoom.renderScale}
          rotation={rotation}
          scale={zoom.scale}
          viewport={viewport}
        />
      </div>
    </div>
  );
}
