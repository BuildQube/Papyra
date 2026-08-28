import type { Document, SearchMatch } from '@build-qube/papyra';
import {
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { PageSurface } from '@/components/pdf-page-surface';
import type { ZoomAnchor } from '@/hooks/use-pdf-zoom';
import { CSS_UNITS, renderWidth } from '@/lib/pdf-zoom';

/** Gap between pages, in CSS pixels. Fixed, so it does not balloon at 800%. */
const GAP = 16;

/** Pages kept mounted either side of the viewport, so a placeholder is never late. */
const MOUNT_MARGIN = 2;

/** Pages rendered either side of the viewport, one priority tier behind. */
const RENDER_MARGIN = 1;

interface Slot {
  index: number;
  top: number;
  left: number;
  width: number;
  height: number;
  /** Page size in PDF points: what highlights and render widths are derived from. */
  pageWidth: number;
  pageHeight: number;
}

interface Layout {
  slots: readonly Slot[];
  width: number;
  height: number;
}

/** Anchored to a page, not to the content box: the gaps do not scale, the pages do. */
interface Anchor {
  index: number;
  fx: number;
  fy: number;
  dx: number;
  dy: number;
}

/** Props for {@link ContinuousPages}. */
export interface ContinuousPagesProps {
  /** The open document. */
  doc: Document;
  /** The scrolling element. Owned by the layout, shared with the zoom gestures. */
  viewport: RefObject<HTMLElement | null>;
  /**
   * Filled in with this view's own anchor, so zoom can keep the point under the
   * cursor where it is. The gaps between pages do not scale with the pages, so this
   * cannot be derived from the DOM.
   */
  anchor: RefObject<ZoomAnchor | null>;
  /** Layout scale — tracks a pinch frame by frame. */
  scale: number;
  /** Render scale — settles behind it, so a pinch does not flood the queue. */
  renderScale: number;
  /** The current page, 0-based. Scrolled to when it changes from outside. */
  page: number;
  /** Called with the page that occupies most of the viewport as it is scrolled. */
  onPage: (index: number) => void;
  /** Search results across the whole document; each page draws its own. */
  matches: readonly SearchMatch[];
  /** The match drawn in the active colour, if it is on a visible page. */
  active: SearchMatch | null;
}

/** Last slot starting at or before `y`. Documents run to thousands of pages. */
function slotAt(slots: readonly Slot[], y: number): number {
  let lo = 0;
  let hi = slots.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((slots[mid]?.top ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/**
 * Continuous scroll, on papyra's queue.
 *
 * The interesting part is not the scrolling, it is what the scrolling does to the
 * queue. Everything in the viewport is submitted at priority 0 and its neighbours at
 * 1; as the column moves, pages already queued are reprioritised in place, and pages
 * that fall out of the window are cancelled — which for anything that has not started
 * drops it from the queue entirely. So a fast scroll through a 400-page document
 * renders where the scroll stopped, not the forty pages that flickered past.
 *
 * Every box is sized from `pageSize()` before anything rasterises, so the column has
 * its final geometry on the first frame: scrolling to page 400 does not wait for the
 * 399 before it, and nothing shifts under the pointer as renders land.
 */
export function ContinuousPages({
  doc,
  viewport,
  anchor,
  scale,
  renderScale,
  page,
  onPage,
  matches,
  active,
}: ContinuousPagesProps) {
  const content = useRef<HTMLDivElement>(null);

  const layout = useMemo<Layout>(() => {
    const sizes = Array.from({ length: doc.pageCount }, (_, i) =>
      doc.pageSize(i),
    );
    const width = sizes.reduce(
      (widest, size) =>
        Math.max(widest, Math.round(size.width * CSS_UNITS * scale)),
      0,
    );
    const slots: Slot[] = [];
    let top = 0;
    for (const [index, size] of sizes.entries()) {
      const w = Math.max(1, Math.round(size.width * CSS_UNITS * scale));
      const h = Math.max(1, Math.round(size.height * CSS_UNITS * scale));
      slots.push({
        index,
        top,
        left: Math.round((width - w) / 2),
        width: w,
        height: h,
        pageWidth: size.width,
        pageHeight: size.height,
      });
      top += h + GAP;
    }
    return { slots, width, height: Math.max(0, top - GAP) };
  }, [doc, scale]);

  // Read from event handlers and layout effects, which run outside React's render.
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // The visible range lives in a ref with a manual nudge rather than in state: the
  // scroll handler runs once per frame and most frames do not move the range at all.
  const range = useRef({ first: 0, last: 0 });
  const [, bump] = useReducer((n: number) => n + 1, 0);

  /** Ignore our own scrolling when deciding which page the reader is on. */
  const settleAt = useRef(0);
  const reported = useRef(page);
  /** Set once `?page=` has been honoured, which has to happen before we report one. */
  const initialised = useRef(false);
  /** Where the top of the viewport sits, in terms that survive a change of scale. */
  const held = useRef<{ index: number; fy: number } | null>(null);

  const measure = useCallback(() => {
    const vp = viewport.current;
    const ct = content.current;
    if (!vp || !ct) return;
    const { slots } = layoutRef.current;
    if (slots.length === 0) return;

    const top = vp.scrollTop - ct.offsetTop;
    const bottom = top + vp.clientHeight;
    const first = slotAt(slots, top);
    const last = slotAt(slots, bottom);

    if (range.current.first !== first || range.current.last !== last) {
      range.current = { first, last };
      bump();
    }

    const anchorSlot = slots[first];
    if (anchorSlot && anchorSlot.height > 0) {
      held.current = {
        index: first,
        fy: (top - anchorSlot.top) / anchorSlot.height,
      };
    }

    if (!initialised.current || performance.now() < settleAt.current) return;

    // The page with the most of itself on screen — what a reader would call "the page
    // I am on" when two of them straddle the fold.
    let best = first;
    let bestVisible = -1;
    for (let i = first; i <= last; i++) {
      const slot = slots[i];
      if (!slot) continue;
      const shown =
        Math.min(bottom, slot.top + slot.height) - Math.max(top, slot.top);
      if (shown > bestVisible) {
        bestVisible = shown;
        best = i;
      }
    }
    if (best !== reported.current) {
      reported.current = best;
      onPage(best);
    }
  }, [viewport, onPage]);

  useEffect(() => {
    const vp = viewport.current;
    if (!vp) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    vp.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      vp.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [viewport, measure]);

  const scrollToPage = useCallback(
    (index: number) => {
      const vp = viewport.current;
      const ct = content.current;
      const slot = layoutRef.current.slots[index];
      if (!vp || !ct || !slot) return;
      vp.scrollTo({ top: ct.offsetTop + slot.top - GAP / 2 });
      settleAt.current = performance.now() + 250;
      // Straight away, not on the scroll event this fires: a jump to page 400 should
      // queue page 400 now rather than a frame later, and the scroll handler is behind
      // a `requestAnimationFrame` that a background tab does not run at all.
      measure();
    },
    [viewport, measure],
  );

  // A page arriving from outside — a thumbnail, an outline entry, a search hit, or
  // `?page=` on the URL — scrolls the column. A page arriving from our own scroll
  // handler must not, or the two chase each other down the document.
  useEffect(() => {
    if (!initialised.current) {
      initialised.current = true;
      reported.current = page;
      if (page > 0) scrollToPage(page);
      return;
    }
    if (page === reported.current) return;
    reported.current = page;
    scrollToPage(page);
  }, [page, scrollToPage]);

  // Re-measure whenever the column is re-laid out. Passive, so it lands after the
  // zoom anchor has already put the scroll position back where it belongs.
  useEffect(() => {
    measure();
  }, [measure, layout]);

  /*
   * Hold the reader's place across a re-layout nobody asked for.
   *
   * A fit mode resolves against the page on screen, so scrolling onto a landscape
   * plate in a portrait document changes the scale and rescales the whole column.
   * Without this the scroll offset stays put while the content moves under it, which
   * lands on a different page, which re-resolves the fit again — a document that
   * mixes page sizes oscillates instead of settling.
   *
   * A gesture zoom overwrites this: the anchor `useZoom` holds runs in the route's
   * layout effect, and a parent's layout effects run after its children's.
   */
  const laidOutAt = useRef(scale);
  useLayoutEffect(() => {
    if (scale === laidOutAt.current) return;
    laidOutAt.current = scale;
    const vp = viewport.current;
    const ct = content.current;
    const keep = held.current;
    const slot = keep ? layoutRef.current.slots[keep.index] : undefined;
    if (!vp || !ct || !keep || !slot) return;
    vp.scrollTop = ct.offsetTop + slot.top + keep.fy * slot.height;
  }, [scale, viewport]);

  useImperativeHandle(
    anchor,
    () => ({
      capture(clientX, clientY) {
        const vp = viewport.current;
        const ct = content.current;
        if (!vp || !ct) return null;
        const rect = vp.getBoundingClientRect();
        const y = vp.scrollTop + (clientY - rect.top) - ct.offsetTop;
        const x = vp.scrollLeft + (clientX - rect.left) - ct.offsetLeft;
        const slots = layoutRef.current.slots;
        const index = slotAt(slots, y);
        const slot = slots[index];
        if (!slot) return null;
        return {
          index,
          fx: slot.width > 0 ? (x - slot.left) / slot.width : 0,
          fy: slot.height > 0 ? (y - slot.top) / slot.height : 0,
          dx: clientX - rect.left,
          dy: clientY - rect.top,
        } satisfies Anchor;
      },
      restore(token) {
        const vp = viewport.current;
        const ct = content.current;
        if (!vp || !ct) return;
        const a = token as Anchor;
        const slot = layoutRef.current.slots[a.index];
        if (!slot) return;
        vp.scrollTop = ct.offsetTop + slot.top + a.fy * slot.height - a.dy;
        vp.scrollLeft = ct.offsetLeft + slot.left + a.fx * slot.width - a.dx;
      },
    }),
    [viewport, anchor],
  );

  const { first, last } = range.current;
  const end = layout.slots.length - 1;
  const mountFirst = Math.max(0, first - MOUNT_MARGIN);
  const mountLast = Math.min(end, last + MOUNT_MARGIN);
  const renderFirst = Math.max(0, first - RENDER_MARGIN);
  const renderLast = Math.min(end, last + RENDER_MARGIN);

  const inWindow = layout.slots.slice(mountFirst, mountLast + 1);

  return (
    <div
      ref={content}
      className="relative"
      style={{ width: layout.width, height: layout.height }}
    >
      {inWindow.map((slot) => (
        <PageSurface
          key={slot.index}
          doc={doc}
          index={slot.index}
          top={slot.top}
          left={slot.left}
          width={slot.width}
          height={slot.height}
          pageWidth={slot.pageWidth}
          renderWidth={
            slot.index >= renderFirst && slot.index <= renderLast
              ? renderWidth(
                  { width: slot.pageWidth, height: slot.pageHeight },
                  renderScale,
                )
              : 0
          }
          priority={slot.index >= first && slot.index <= last ? 0 : 1}
          matches={matches}
          active={active}
          current={slot.index === page}
          onSelect={onPage}
        />
      ))}
    </div>
  );
}
