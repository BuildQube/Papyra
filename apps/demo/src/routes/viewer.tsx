import { useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Highlights } from '../components/Highlights.js';
import { PageView, type PageViewHandle } from '../components/PageView.js';
import { ViewerLayout } from '../components/ViewerLayout.js';
import { useDocument } from '../lib/documentContext.js';
import { usePage } from '../lib/usePage.js';
import { defaultViewWidth } from '../lib/width.js';

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

interface Search {
  width?: number;
  thumbs?: boolean;
  probe?: number;
}

/**
 * The canvas path: render to RGBA, `putImageData`, done. No decode step anywhere,
 * which is why it wins on time to first pixel and loses by ~27x on bytes.
 */
export function ViewerRoute() {
  const { loaded, setError, matches, active } = useDocument();
  const [page, setPage] = usePage();
  const {
    width,
    thumbs,
    probe: probeCount,
  } = useSearch({
    strict: false,
  }) as Search;

  const view = useRef<PageViewHandle>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [timing, setTiming] = useState<Timing | null>(null);
  const [cacheHits, setCacheHits] = useState(0);
  const probe = useRef<((t: Timing) => void) | null>(null);

  const viewWidth = width ?? defaultViewWidth();
  const doc = loaded?.doc;

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const started = performance.now();
    setTiming(null);

    const job = doc.render(page, { fitWidth: viewWidth, priority: 0 });
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
        setCacheHits(doc.cache.hits);
        setTiming(t);
        probe.current?.(t);
      })
      .catch((e: Error) => !cancelled && setError(e.message));

    return () => {
      cancelled = true;
    };
  }, [doc, page, viewWidth, setError]);

  // ?probe=N steps through N pages and reports timings to the dev server, so page
  // navigation can be measured without a human clicking. Dev affordance only.
  useEffect(() => {
    const n = probeCount;
    if (!doc || !n || !Number.isFinite(n) || n <= 0) return;
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
      setTimeout(() => setPage(i % 4), 50);
    };
    return () => {
      probe.current = null;
    };
  }, [doc, probeCount, setPage]);

  return (
    <ViewerLayout
      showThumbs={thumbs !== false}
      status={
        timing && (
          <span className="muted">
            canvas · page {page + 1}
            {size && ` · ${size.w}×${size.h}`} · wait {timing.wait.toFixed(0)} ·
            run {timing.run.toFixed(0)} · paint {timing.paint.toFixed(0)} ·
            present {timing.present.toFixed(0)} · {cacheHits} cached ·{' '}
            <strong>visible {timing.visible.toFixed(0)}ms</strong>
          </span>
        )
      }
    >
      <div className="page-stack">
        <PageView ref={view} className="page" />
        {size && loaded && (
          <Highlights
            matches={matches.filter((m) => m.page === page)}
            active={active?.page === page ? active : null}
            // Text is reported at 72 DPI, so this is the render's own ratio.
            scale={size.w / loaded.doc.pageSize(page).width}
            width={size.w}
            height={size.h}
          />
        )}
      </div>
    </ViewerLayout>
  );
}
