import {
  type PagedEngine,
  type PdfSource,
  type Rotation,
  rotateSize,
  type SearchMatch,
} from '@build-qube/papyra/core';
import { type OfficeDoc, officeEngine } from '@build-qube/papyra/office';
import { FileIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ContinuousPages } from '@/components/pdf-continuous-pages';
import { EngineGuard, PageEngineScope } from '@/components/pdf-engine';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
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
  /**
   * Lays out and draws the files. papyra's own `officeEngine` when unset;
   * `TauriOfficeEngine` from `@build-qube/papyra-tauri` runs them in a Tauri app's
   * host process instead, as `pptxRenderer.with({ engine })`.
   */
  engine?: OfficeEngine;
}

/** What the view needs of an office engine: pages, and fonts for their layout. */
export type OfficeEngine = PagedEngine<OfficeDoc> & {
  /** Register a font for documents opened after it; see papyra's `addFont`. */
  addFont(source: PdfSource): Promise<number>;
};

/** Each URL fetched once per engine and page load, whichever preview asks first. */
const registered = new WeakMap<OfficeEngine, Map<string, Promise<void>>>();

function registerFonts(
  engine: OfficeEngine,
  urls: readonly string[],
): Promise<void> {
  const known = registered.get(engine) ?? new Map<string, Promise<void>>();
  registered.set(engine, known);
  return Promise.all(
    urls.map((url) => {
      let done = known.get(url);
      if (!done) {
        // A font that fails to load costs fidelity, not the preview: the engines
        // fall back to what they have.
        done = fetch(url)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
          .then((b) => engine.addFont(new Uint8Array(b)))
          .then(
            () => undefined,
            (e: unknown) => console.warn(`papyra: font ${url} not loaded`, e),
          );
        known.set(url, done);
      }
      return done;
    }),
  ).then(() => undefined);
}

type Opened =
  | { status: 'opening' }
  | { status: 'open'; doc: OfficeDoc }
  | { status: 'failed'; error: unknown };

/**
 * A Word document or PowerPoint deck, laid out and drawn by papyra in Rust —
 * WordCraft for Word, DeckCraft for slides — in the PDF viewer's continuous column.
 *
 * Unlike `docx-preview` this is a real pagination: page breaks, headers and footers
 * land where Word puts them, given the fonts (see {@link OfficeFileViewOptions.fonts}).
 * Experimental, as the engines are.
 *
 * Loaded by `pptxRenderer` and `docxPagedRenderer` — import
 * those, not this, so papyra stays out of the bundle until a file is opened.
 */
export function OfficeFileView({
  file,
  options,
}: FileViewProps<OfficeFileViewOptions>) {
  const engine = options.engine ?? officeEngine;
  return (
    <EngineGuard engine={engine}>
      <OpenedOffice engine={engine} file={file} fonts={options.fonts} />
    </EngineGuard>
  );
}

function OpenedOffice({
  file,
  fonts,
  engine,
}: Pick<FileViewProps, 'file'> & {
  fonts?: readonly string[] | undefined;
  engine: OfficeEngine;
}) {
  const [opened, setOpened] = useState<Opened>({ status: 'opening' });
  // Joined so that a new array with the same URLs, as an inline `options` object
  // makes on every render, does not reopen the file.
  const fontKey = (fonts ?? []).join('\n');

  useEffect(() => {
    let live = true;
    setOpened({ status: 'opening' });
    registerFonts(engine, fontKey ? fontKey.split('\n') : [])
      .then(() => engine.open(file))
      .then(
        (doc) => {
          // Opened after the file changed or the view went away: nobody shows it.
          if (!live) return void engine.close(doc).catch(() => {});
          setOpened({ status: 'open', doc });
        },
        (error: unknown) => live && setOpened({ status: 'failed', error }),
      );
    return () => {
      live = false;
    };
  }, [file, fontKey, engine]);

  // Closed when the file changes or the view goes away, so its pages leave the cache.
  const doc = opened.status === 'open' ? opened.doc : null;
  useEffect(() => {
    if (!doc) return;
    return () => {
      engine.close(doc).catch(() => {});
    };
  }, [doc, engine]);

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
      // A valid file can have none — a deck or template with no slides yet — and the
      // column sizes itself from the first page.
      if (opened.doc.pageCount === 0) return <NoPages kind={opened.doc.kind} />;
      return (
        <PageEngineScope engine={engine}>
          <OfficePages doc={opened.doc} />
        </PageEngineScope>
      );
  }
}

function NoPages({ kind }: { kind: OfficeDoc['kind'] }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileIcon />
        </EmptyMedia>
        <EmptyTitle>{kind === 'slides' ? 'No slides' : 'No pages'}</EmptyTitle>
        <EmptyDescription>
          {kind === 'slides'
            ? 'This deck has no slides to show.'
            : 'This document has no pages to show.'}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** No search for office documents yet, so every page draws no matches. */
const NO_MATCHES: readonly SearchMatch[] = [];

/**
 * Every page in one scrolling column, as the PDF viewer shows them, with its zoom
 * bar: fit modes, pinch and wheel zoom, rotation, and a page box that follows the
 * scroll. The column is the PDF one, unchanged: it renders through the office engine
 * the provider above sets, so only the pages in and near the viewport are rendered,
 * and the queue is reprioritised as they scroll by.
 */
function OfficePages({ doc }: { doc: OfficeDoc }) {
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
