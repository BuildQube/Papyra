import {
  backend,
  currentRuntime,
  type Document,
  open,
  type RenderedPage,
} from '@build-qube/papyra';
import { useCallback, useEffect, useState } from 'react';
import { BenchPanel } from './components/BenchPanel.js';
import { PageCanvas } from './components/PageCanvas.js';
import { Thumbnails } from './components/Thumbnails.js';

interface Loaded {
  doc: Document;
  bytes: Uint8Array;
  name: string;
}

/**
 * Render the viewport by output width rather than DPI: 150 DPI is 6300x4500 (113 MB)
 * for an ARCH-E drawing, all of it thrown away by a ~900px-wide viewport.
 */
const VIEW_WIDTH = Math.min(
  2000,
  Math.round(window.screen.width * (window.devicePixelRatio || 1)),
);

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<RenderedPage | null>(null);
  const [renderMs, setRenderMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (file: File) => {
    setError(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // papyra takes the File directly; we keep the bytes for the benchmark panel.
      // A viewer wants a narrow pool: priority can only reorder work that has not
      // started, so a wide pool makes the visible page wait behind more in-flight
      // renders. Measured 5.2x faster to the visible page at 4 vs 1.1x at 18.
      const doc = await open(file, { concurrency: 4 });
      setLoaded({ doc, bytes, name: file.name });
      setPageIndex(0);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // ?file=/some.pdf loads without a file picker — handy for reproducing a specific
  // document, and for driving the demo from a script.
  useEffect(() => {
    const url = new URLSearchParams(window.location.search).get('file');
    if (!url) return;
    void (async () => {
      try {
        const res = await fetch(url);
        const blob = await res.blob();
        await load(new File([blob], url.split('/').pop() ?? 'document.pdf'));
      } catch (e) {
        setError(`could not load ${url}: ${(e as Error).message}`);
      }
    })();
  }, [load]);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const started = performance.now();
    loaded.doc
      .renderPage(pageIndex, { fitWidth: VIEW_WIDTH, priority: 0 })
      .then((rendered) => {
        if (cancelled) return;
        setPage(rendered);
        setRenderMs(performance.now() - started);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [loaded, pageIndex]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>papyra</h1>
        <span className="badge">{currentRuntime()}</span>
        <span className="badge">{backend()}</span>
        <label className="file">
          Open PDF
          <input
            type="file"
            accept="application/pdf"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void load(file);
            }}
          />
        </label>
        {renderMs !== null && (
          <span className="muted">
            page {pageIndex + 1} in {renderMs.toFixed(1)}ms
            {page && ` · ${page.width}×${page.height}`}
          </span>
        )}
      </header>

      {error && <p className="error">{error}</p>}

      {!loaded ? (
        <section
          aria-label="Drop a PDF to open it"
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) void load(file);
          }}
        >
          <p>Drop a PDF here, or use “Open PDF”.</p>
          <p className="muted">
            Rendered by hayro compiled to wasm, running in this tab.
          </p>
        </section>
      ) : (
        <main className="workspace">
          <Thumbnails
            doc={loaded.doc}
            current={pageIndex}
            onSelect={setPageIndex}
          />
          <section className="viewer">
            <PageCanvas page={page} className="page" />
          </section>
          <BenchPanel bytes={loaded.bytes} name={loaded.name} />
        </main>
      )}
    </div>
  );
}
