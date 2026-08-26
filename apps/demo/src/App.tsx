import {
  backend,
  currentRuntime,
  type Document,
  type EncodedFormat,
  open,
} from '@build-qube/papyra';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BenchPanel } from './components/BenchPanel.js';
import { PageView, type PageViewHandle } from './components/PageView.js';
import { Thumbnails } from './components/Thumbnails.js';

interface Timing {
  /** Queued behind other work before this render started. */
  wait: number;
  /** Actually rendering. */
  run: number;
  /** Submitted to the scheduler until the bitmap came back. */
  render: number;
  /** Bitmap in hand until React committed and the paint effect ran. */
  commit: number;
  /** putImageData. */
  paint: number;
  /** putImageData done until the compositor showed the frame. */
  present: number;
  /** Request until the pixels were actually on screen. */
  visible: number;
}

interface Loaded {
  doc: Document;
  bytes: Uint8Array;
  name: string;
}

/**
 * Render the viewport by output width rather than DPI: 150 DPI is 6300x4500 (113 MB)
 * for an ARCH-E drawing, all of it thrown away by a ~900px-wide viewport.
 */
const VIEW_WIDTH =
  Number(new URLSearchParams(window.location.search).get('width')) ||
  Math.min(
    2000,
    Math.round(window.screen.width * (window.devicePixelRatio || 1)),
  );

// ?thumbs=0 disables the strip, to separate render-queue contention from main-thread
// contention when measuring.
const showThumbs =
  new URLSearchParams(window.location.search).get('thumbs') !== '0';

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const view = useRef<PageViewHandle>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [timing, setTiming] = useState<Timing | null>(null);
  const [cacheHits, setCacheHits] = useState(0);
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
    setTiming(null);
    const job = loaded.doc.render(pageIndex, {
      fitWidth: VIEW_WIDTH,
      priority: 0,
    });
    job.promise
      .then(async (rendered) => {
        if (cancelled) return;
        const render = performance.now() - started;
        // Paint straight through: the bitmap never enters React state, so it can be
        // collected as soon as the canvas has the pixels.
        const painted = (await view.current?.paint(rendered)) ?? {
          paintMs: 0,
          presentMs: 0,
        };
        if (cancelled) return;
        const visible = performance.now() - started;
        const t: Timing = {
          wait: job.timing?.waitMs ?? 0,
          run: job.timing?.runMs ?? 0,
          render,
          commit: visible - render - painted.paintMs - painted.presentMs,
          paint: painted.paintMs,
          present: painted.presentMs,
          visible,
        };
        setSize({ w: rendered.width, h: rendered.height });
        setCacheHits(loaded.doc.cache.hits);
        setTiming(t);
        probe.current?.(t);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [loaded, pageIndex]);

  // ?probe=N steps through N pages and reports timings to the dev server, so page
  // navigation can be measured without a human clicking. Dev affordance only.
  const probe = useRef<((t: Timing) => void) | null>(null);
  useEffect(() => {
    const n = Number(new URLSearchParams(window.location.search).get('probe'));
    if (!loaded || !Number.isFinite(n) || n <= 0) return;
    const rows: string[] = [];
    let i = 0;
    probe.current = (t) => {
      rows.push(
        `visit ${String(i + 1).padStart(2)} (page ${(i % 4) + 1})  ` +
          `wait ${t.wait.toFixed(0).padStart(5)}  ` +
          `run ${t.run.toFixed(0).padStart(4)}  commit ${t.commit.toFixed(0).padStart(4)}  ` +
          `paint ${t.paint.toFixed(0).padStart(3)}  present ${t.present.toFixed(0).padStart(3)}  ` +
          `= visible ${t.visible.toFixed(0).padStart(5)}ms`,
      );
      // Cycle over a few pages so the back half of the run revisits pages the front
      // half already rendered — that is where a cache shows up.
      if (++i >= n) {
        probe.current = null;
        void fetch('/__perf', { method: 'POST', body: rows.join('\n') });
        return;
      }
      setTimeout(() => setPageIndex(i % 4), 50);
    };
    return () => {
      probe.current = null;
    };
  }, [loaded]);

  /**
   * Export the current page. This is the only path in the demo that exercises the
   * encoders inside wasm, and the only one that produces a blob URL — a viewer-side
   * download that never materialises the raw bitmap in JS.
   */
  const exportPage = useCallback(
    async (format: EncodedFormat) => {
      if (!loaded) return;
      setExporting(true);
      try {
        const img = await loaded.doc.renderImage(pageIndex, { fitWidth: 2000 });
        const encoded = await img.encode({ format });
        const url = encoded.toBlobUrl();
        const a = document.createElement('a');
        a.href = url;
        a.download = `${loaded.name.replace(/\.pdf$/i, '')}-p${pageIndex + 1}.${
          format === 'jpeg' ? 'jpg' : format
        }`;
        a.click();
        // The anchor is gone; nothing else holds the blob.
        URL.revokeObjectURL(url);
        setExported(
          `${format} · ${(encoded.bytes.length / 1024).toFixed(0)} KB ` +
            `(raw ${(img.byteLength / 1e6).toFixed(1)} MB)`,
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setExporting(false);
      }
    },
    [loaded, pageIndex],
  );

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
        {timing && (
          <span className="muted">
            page {pageIndex + 1}
            {size && ` · ${size.w}×${size.h}`} · wait {timing.wait.toFixed(0)} ·
            run {timing.run.toFixed(0)} · paint {timing.paint.toFixed(0)} ·
            present {timing.present.toFixed(0)} · {cacheHits} cached ·{' '}
            <strong>visible {timing.visible.toFixed(0)}ms</strong>
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
          {showThumbs && (
            <Thumbnails
              doc={loaded.doc}
              current={pageIndex}
              onSelect={setPageIndex}
            />
          )}
          <section className="viewer">
            <PageView ref={view} className="page" />
            <div className="export">
              <span className="muted">export page {pageIndex + 1}:</span>
              {(['webp', 'png', 'jpeg'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  disabled={exporting}
                  onClick={() => void exportPage(f)}
                >
                  {f}
                </button>
              ))}
              {exported && <span className="muted">{exported}</span>}
            </div>
          </section>
          <BenchPanel bytes={loaded.bytes} name={loaded.name} />
        </main>
      )}
    </div>
  );
}
