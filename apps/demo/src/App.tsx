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

const VIEW_DPI = 150;

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
      const doc = await open(file);
      setLoaded({ doc, bytes, name: file.name });
      setPageIndex(0);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let cancelled = false;
    const started = performance.now();
    loaded.doc
      .renderPage(pageIndex, { dpi: VIEW_DPI })
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
            page {pageIndex + 1} in {renderMs.toFixed(1)}ms @ {VIEW_DPI} DPI
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
