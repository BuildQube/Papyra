import type { Document } from '@build-qube/papyra';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ContinuousPages } from '../components/ContinuousPages.js';
import { Highlights } from '../components/Highlights.js';
import { Links } from '../components/Links.js';
import { PageView, type PageViewHandle } from '../components/PageView.js';
import { ViewerLayout } from '../components/ViewerLayout.js';
import { type ViewMode, ZoomBar } from '../components/ZoomBar.js';
import { useDocument } from '../lib/documentContext.js';
import { usePage } from '../lib/usePage.js';
import {
  labelsDiffer,
  pageLabel,
  usePageLabels,
} from '../lib/usePageLabels.js';
import { useZoom, type ZoomAnchor } from '../lib/useZoom.js';
import {
  formatZoom,
  pageBox,
  renderWidth,
  type ZoomSpec,
} from '../lib/zoom.js';

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
  zoom?: ZoomSpec;
  view?: ViewMode;
}

/** `.viewer-scroll`'s padding, which content cannot use when fitting. */
const GUTTER = 48;

/** The point under the cursor, as a fraction of the one page on screen. */
interface PageAnchor {
  fx: number;
  fy: number;
  clientX: number;
  clientY: number;
}

/**
 * The canvas path: render to RGBA, `putImageData`, done. No decode step anywhere,
 * which is why it wins on time to first pixel and loses by ~27x on bytes.
 */
export function ViewerRoute() {
  const { loaded, setError, matches, active } = useDocument();
  const [page, setPage] = usePage();
  const navigate = useNavigate();
  const {
    width,
    thumbs,
    probe: probeCount,
    zoom: zoomParam,
    view,
  } = useSearch({
    strict: false,
  }) as Search;

  const mode: ViewMode = view === 'scroll' ? 'scroll' : 'page';
  const doc = loaded?.doc;

  const viewport = useRef<HTMLDivElement>(null);
  const anchor = useRef<ZoomAnchor | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const surface = useRef<PageViewHandle>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [timing, setTiming] = useState<Timing | null>(null);
  const [cacheHits, setCacheHits] = useState(0);
  const probe = useRef<((t: Timing) => void) | null>(null);

  const index = doc ? Math.min(page, doc.pageCount - 1) : 0;
  const labels = usePageLabels(doc);
  // Only worth the space when the document disagrees with the index — showing "3"
  // next to "3" is noise.
  const label = labelsDiffer(labels) ? pageLabel(labels, index) : '';
  const pageSize = useMemo(
    () => (doc ? doc.pageSize(index) : null),
    [doc, index],
  );

  const patch = useCallback(
    (next: Partial<Search>) => {
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, ...next }),
        replace: true,
      });
    },
    [navigate],
  );

  const zoom = useZoom({
    viewport,
    page: pageSize,
    gutter: GUTTER,
    initial: zoomParam ?? 'auto',
    anchor,
    onCommit: useCallback((spec: ZoomSpec) => patch({ zoom: spec }), [patch]),
  });

  const box = pageSize ? pageBox(pageSize, zoom.scale) : null;

  // Zoom decides how many pixels a page is worth. `?width=` still pins it, which is
  // how the perf probe and a like-for-like comparison against /export stay honest.
  const pixelWidth = pageSize
    ? (width ?? renderWidth(pageSize, zoom.renderScale))
    : 0;

  // A single page scales about the cursor exactly: it is one box scaling uniformly,
  // so the fraction of it under the pointer is preserved and the DOM can be measured
  // straight. The continuous view cannot do this — see `ContinuousPages`.
  useImperativeHandle(
    mode === 'page' ? anchor : null,
    () => ({
      capture(clientX, clientY) {
        const el = stack.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
          fx: (clientX - rect.left) / rect.width,
          fy: (clientY - rect.top) / rect.height,
          clientX,
          clientY,
        } satisfies PageAnchor;
      },
      restore(token) {
        const el = stack.current;
        const vp = viewport.current;
        if (!el || !vp) return;
        const a = token as PageAnchor;
        const rect = el.getBoundingClientRect();
        vp.scrollLeft += rect.left + a.fx * rect.width - a.clientX;
        vp.scrollTop += rect.top + a.fy * rect.height - a.clientY;
      },
    }),
    [mode],
  );

  useEffect(() => {
    if (!doc || mode !== 'page' || pixelWidth <= 0) return;
    let cancelled = false;
    const started = performance.now();
    setTiming(null);

    const job = doc.render(index, { fitWidth: pixelWidth, priority: 0 });
    job.promise
      .then(async (rendered) => {
        if (cancelled) return;
        const render = performance.now() - started;
        const painted = (await surface.current?.paint(rendered)) ?? {
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
      job.cancel('page or zoom changed');
    };
  }, [doc, index, pixelWidth, mode, setError]);

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
          `= visible ${t.visible.toFixed(0)}ms`,
      );
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
      viewport={viewport}
      toolbar={
        doc && (
          <ZoomBar
            spec={zoom.spec}
            scale={zoom.scale}
            page={index}
            pageCount={doc.pageCount}
            label={label}
            mode={mode}
            settling={zoom.settling}
            onSpec={(spec) => zoom.setSpec(spec)}
            onStepIn={zoom.stepIn}
            onStepOut={zoom.stepOut}
            onPage={setPage}
            onMode={(next) => patch({ view: next })}
          />
        )
      }
      status={
        mode === 'scroll'
          ? doc && <QueueStatus doc={doc} scale={zoom.scale} />
          : timing && (
              <span className="muted">
                canvas · page {index + 1} · {formatZoom(zoom.scale)}
                {size && ` · ${size.w}×${size.h}`} · wait{' '}
                {timing.wait.toFixed(0)} · run {timing.run.toFixed(0)} · paint{' '}
                {timing.paint.toFixed(0)} · present {timing.present.toFixed(0)}{' '}
                · {cacheHits} cached ·{' '}
                <strong>visible {timing.visible.toFixed(0)}ms</strong>
              </span>
            )
      }
    >
      {doc && mode === 'scroll' ? (
        // Keyed, so opening a different file starts the column over rather than
        // inheriting the old one's scroll position and visible range.
        <ContinuousPages
          key={loaded.name}
          doc={doc}
          viewport={viewport}
          anchor={anchor}
          scale={zoom.scale}
          renderScale={zoom.renderScale}
          page={index}
          onPage={setPage}
          matches={matches}
          active={active}
        />
      ) : (
        <div className="page-stack" ref={stack} style={box ?? undefined}>
          <PageView
            ref={surface}
            className="page zoomable"
            style={box ?? undefined}
          />
          {size && loaded && (
            <>
              <Links
                doc={loaded.doc}
                index={index}
                scale={
                  (box?.width ?? size.w) / loaded.doc.pageSize(index).width
                }
                onSelect={setPage}
              />
              <Highlights
                matches={matches.filter((m) => m.page === index)}
                active={active?.page === index ? active : null}
                scale={
                  (box?.width ?? size.w) / loaded.doc.pageSize(index).width
                }
                width={box?.width ?? size.w}
                height={box?.height ?? size.h}
              />
            </>
          )}
        </div>
      )}
    </ViewerLayout>
  );
}

/**
 * The scheduler, live.
 *
 * Isolated in its own component because it polls: a readout that re-rendered the whole
 * viewer four times a second to say "0 pending" would be measuring itself.
 */
function QueueStatus({ doc, scale }: { doc: Document; scale: number }) {
  const [queue, setQueue] = useState(() => doc.queued);
  const [hits, setHits] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      const next = doc.queued;
      setQueue((prev) =>
        prev.pending === next.pending && prev.running === next.running
          ? prev
          : next,
      );
      setHits(doc.cache.hits);
    }, 250);
    return () => clearInterval(timer);
  }, [doc]);

  return (
    <span className="muted">
      continuous · {doc.pageCount} pages · {formatZoom(scale)} ·{' '}
      <strong>{queue.running} rendering</strong> · {queue.pending} queued ·{' '}
      {hits} cached
    </span>
  );
}
