import type { PageSize } from '@build-qube/papyra';
import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  clampZoom,
  resolveZoom,
  type Viewport,
  type ZoomSpec,
  zoomIn,
  zoomOut,
} from '@/lib/pdf-zoom';

/**
 * How long after the last gesture frame the pages are re-rasterised.
 *
 * A pinch produces a zoom change per frame and a render costs tens to hundreds of
 * milliseconds, so rasterising every frame would queue work faster than it drains and
 * leave the queue minutes behind the finger. Instead the layout follows the gesture
 * exactly and the existing canvases are stretched to it — blurry, but instant — and
 * only the settled scale is ever rendered.
 */
const SETTLE_MS = 140;

/** Per event, so one absurd `deltaY` cannot jump three ladder steps. */
const MAX_WHEEL_FACTOR = 1.25;

/**
 * Divisor turning `deltaY` into a scale factor.
 *
 * A trackpad pinch arrives as a stream of small ctrl+wheel deltas (~1-10 per frame)
 * and a mouse notch as a single ~100, so one constant has to serve both: 400 makes a
 * notch 1.28x — about a ladder step — and a pinch frame ~1.5%, which reads as smooth.
 */
const WHEEL_DIVISOR = 400;

/**
 * How a view describes the point under the cursor so zoom can keep it there.
 *
 * Anchoring cannot be done generically from the DOM: in the continuous view the gaps
 * between pages do not scale with the pages, so the fraction of the content box under
 * the cursor is not preserved across a zoom. Each view knows its own geometry and
 * expresses the point in terms that survive.
 */
export interface ZoomAnchor {
  /** Describe the point under these client coordinates, however this view must. */
  capture(clientX: number, clientY: number): unknown;
  /** Put the point described by `token` back where it was, after a scale change. */
  restore(token: unknown): void;
}

/** Options for {@link useZoom}. */
export interface ZoomOptions {
  /** The scrolling element gestures are bound to and scroll is corrected on. */
  viewport: RefObject<HTMLElement | null>;
  /** The page the fit modes measure against — whichever one is on screen. */
  page: PageSize | null;
  /** Padding inside the viewport that content cannot use. */
  gutter?: number;
  /** The zoom to start at. Defaults to `auto`. */
  initial?: ZoomSpec;
  /** Whichever view is mounted; used to keep a point under the cursor. */
  anchor?: RefObject<ZoomAnchor | null>;
  /** Debounced, so a pinch does not write one URL update per frame. */
  onCommit?: (spec: ZoomSpec) => void;
}

/** What {@link useZoom} returns: the current zoom, and the ways to change it. */
export interface ZoomController {
  /** What the user asked for: a percentage or a fit mode. */
  spec: ZoomSpec;
  /** The resolved scale the layout uses. Tracks a gesture frame by frame. */
  scale: number;
  /** The resolved scale renders are requested at. Lags `scale` mid-gesture. */
  renderScale: number;
  /** True while the two disagree — i.e. what is on screen is a stretched bitmap. */
  settling: boolean;
  /**
   * Set the zoom. The optional client coordinates are the point to keep still —
   * a cursor or the midpoint of a pinch.
   */
  setSpec: (spec: ZoomSpec, clientX?: number, clientY?: number) => void;
  /** One rung up the ladder, anchored on the viewport centre. */
  stepIn: () => void;
  /** One rung down. */
  stepOut: () => void;
  /** Usable viewport size, so a view can size fit modes the same way. */
  viewport: Viewport;
}

/** Safari's trackpad pinch. Not in lib.dom, and not synthesised as ctrl+wheel. */
interface SafariGestureEvent extends Event {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * Zoom for a scrolling viewport: wheel, pinch, keyboard, and the fit modes.
 *
 * The scale the layout follows and the scale renders are requested at are separate,
 * so a gesture stays smooth while the queue only ever sees settled values.
 */
export function useZoom(options: ZoomOptions): ZoomController {
  const {
    viewport: viewportRef,
    page,
    gutter = 0,
    initial = 'auto',
    anchor,
    onCommit,
  } = options;

  const [spec, setSpecState] = useState<ZoomSpec>(initial);
  const [box, setBox] = useState<Viewport>({ width: 0, height: 0 });

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const measure = () =>
      setBox((prev) => {
        const width = Math.max(0, el.clientWidth - gutter);
        const height = Math.max(0, el.clientHeight - gutter);
        return prev.width === width && prev.height === height
          ? prev
          : { width, height };
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewportRef, gutter]);

  // Destructured because `pageSize()` hands back a fresh object every call, which as
  // a dependency would re-resolve the zoom on every render of the route.
  const pw = page?.width ?? 0;
  const ph = page?.height ?? 0;
  const scale = useMemo(
    () => resolveZoom(spec, pw > 0 ? { width: pw, height: ph } : null, box),
    [spec, pw, ph, box],
  );

  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // --- keeping a point under the cursor ------------------------------------------
  //
  // Captured synchronously in the event handler against the current layout, restored
  // in a layout effect once React has committed the new one. Dropped if the scale did
  // not actually move (a clamp at either end of the range), so a stale token can never
  // be spent on the next zoom.
  const pending = useRef<{ token: unknown } | null>(null);
  const applied = useRef(scale);

  useLayoutEffect(() => {
    const token = pending.current;
    pending.current = null;
    const moved = scale !== applied.current;
    applied.current = scale;
    if (token && moved) anchor?.current?.restore(token.token);
  });

  const setSpec = useCallback(
    (next: ZoomSpec, clientX?: number, clientY?: number) => {
      if (clientX !== undefined && clientY !== undefined) {
        const token = anchor?.current?.capture(clientX, clientY);
        pending.current = token == null ? null : { token };
      }
      if (typeof next === 'number') {
        // Optimistic, because a trackpad can deliver several wheel events between two
        // React renders and each one multiplies the last: reading the committed scale
        // would make every event after the first in a frame a no-op.
        const clamped = clampZoom(next);
        scaleRef.current = clamped;
        setSpecState(clamped);
      } else {
        setSpecState(next);
      }
    },
    [anchor],
  );

  const centre = useCallback((): [number, number] | null => {
    const el = viewportRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return [rect.left + rect.width / 2, rect.top + rect.height / 2];
  }, [viewportRef]);

  const stepIn = useCallback(() => {
    const at = centre();
    setSpec(zoomIn(scaleRef.current), at?.[0], at?.[1]);
  }, [centre, setSpec]);

  const stepOut = useCallback(() => {
    const at = centre();
    setSpec(zoomOut(scaleRef.current), at?.[0], at?.[1]);
  }, [centre, setSpec]);

  // --- what we actually rasterise -------------------------------------------------
  const [renderScale, setRenderScale] = useState(scale);
  useEffect(() => {
    if (renderScale === scale) return;
    const timer = setTimeout(() => setRenderScale(scale), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [scale, renderScale]);

  // --- URL writeback --------------------------------------------------------------
  const commit = useRef(onCommit);
  commit.current = onCommit;
  const committed = useRef(spec);
  useEffect(() => {
    if (spec === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = spec;
      commit.current?.(spec);
    }, 400);
    return () => clearTimeout(timer);
  }, [spec]);

  // --- gestures --------------------------------------------------------------------
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    /** Safari fires gesture events *and* wheel events; the wheel half is ignored. */
    let gesturing = false;
    let gestureBase = 1;
    let pinchSpan = 0;
    let pinchBase = 1;

    const onWheel = (event: WheelEvent) => {
      if (gesturing) return;
      // Chrome and Firefox synthesise a trackpad pinch as ctrl+wheel; a mouse gets
      // the same job done with the modifier held. Without preventDefault the browser
      // zooms its own chrome, which is never what someone zooming a document meant.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();

      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? el.clientHeight
            : 1;
      const factor = Math.min(
        MAX_WHEEL_FACTOR,
        Math.max(
          1 / MAX_WHEEL_FACTOR,
          Math.exp((-event.deltaY * unit) / WHEEL_DIVISOR),
        ),
      );
      setSpec(
        clampZoom(scaleRef.current * factor),
        event.clientX,
        event.clientY,
      );
    };

    const span = (touches: TouchList): number => {
      const a = touches.item(0);
      const b = touches.item(1);
      if (!a || !b) return 0;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) return;
      pinchSpan = span(event.touches);
      pinchBase = scaleRef.current;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || pinchSpan <= 0) return;
      const a = event.touches.item(0);
      const b = event.touches.item(1);
      if (!a || !b) return;
      event.preventDefault();
      setSpec(
        clampZoom((pinchBase * span(event.touches)) / pinchSpan),
        (a.clientX + b.clientX) / 2,
        (a.clientY + b.clientY) / 2,
      );
    };

    const onTouchEnd = () => {
      pinchSpan = 0;
    };

    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gesturing = true;
      gestureBase = scaleRef.current;
    };

    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as SafariGestureEvent;
      setSpec(
        clampZoom(gestureBase * gesture.scale),
        gesture.clientX,
        gesture.clientY,
      );
    };

    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      gesturing = false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        stepIn();
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        stepOut();
      } else if (event.key === '0') {
        event.preventDefault();
        const at = centre();
        setSpec(1, at?.[0], at?.[1]);
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('gestureend', onGestureEnd);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [viewportRef, setSpec, stepIn, stepOut, centre]);

  return {
    spec,
    scale,
    renderScale,
    settling: scale !== renderScale,
    setSpec,
    stepIn,
    stepOut,
    viewport: box,
  };
}
