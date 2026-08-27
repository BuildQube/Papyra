import {
  FIT_MODES,
  formatZoom,
  isFitMode,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  type ZoomSpec,
} from '../lib/zoom.js';

export type ViewMode = 'page' | 'scroll';

interface Props {
  spec: ZoomSpec;
  /** The resolved scale, which is what a fit mode actually came out as. */
  scale: number;
  page: number;
  pageCount: number;
  mode: ViewMode;
  /** True while the pages on screen are a stretched bitmap awaiting a re-render. */
  settling: boolean;
  onSpec: (spec: ZoomSpec) => void;
  onStepIn: () => void;
  onStepOut: () => void;
  onPage: (index: number) => void;
  onMode: (mode: ViewMode) => void;
}

const FIT_LABELS: Record<string, string> = {
  auto: 'Automatic',
  'page-fit': 'Page fit',
  'page-width': 'Page width',
};

export function ZoomBar({
  spec,
  scale,
  page,
  pageCount,
  mode,
  settling,
  onSpec,
  onStepIn,
  onStepOut,
  onPage,
  onMode,
}: Props) {
  // A pinch lands on values the ladder does not have, and a select with no matching
  // option renders blank — so the current scale is always offered as an option.
  const custom =
    typeof spec === 'number' && !ZOOM_STEPS.includes(spec) ? spec : null;

  return (
    <>
      <div className="pager">
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 0}
          onClick={() => onPage(page - 1)}
        >
          ‹
        </button>
        <input
          type="number"
          aria-label="Page number"
          min={1}
          max={pageCount}
          value={page + 1}
          onChange={(e) => {
            const next = Number(e.target.value) - 1;
            if (Number.isInteger(next) && next >= 0 && next < pageCount) {
              onPage(next);
            }
          }}
        />
        <span className="muted">of {pageCount}</span>
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
        >
          ›
        </button>
      </div>

      <div className="pager">
        <button
          type="button"
          aria-label="Zoom out"
          disabled={scale <= MIN_ZOOM}
          onClick={onStepOut}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          disabled={scale >= MAX_ZOOM}
          onClick={onStepIn}
        >
          +
        </button>
        <select
          aria-label="Zoom"
          className={settling ? 'zoom settling' : 'zoom'}
          value={typeof spec === 'number' ? String(spec) : spec}
          onChange={(e) =>
            onSpec(
              isFitMode(e.target.value)
                ? e.target.value
                : Number(e.target.value),
            )
          }
        >
          {FIT_MODES.map((fit) => (
            <option key={fit} value={fit}>
              {FIT_LABELS[fit] ?? fit}
              {spec === fit ? ` · ${formatZoom(scale)}` : ''}
            </option>
          ))}
          {custom !== null && (
            <option value={String(custom)}>{formatZoom(custom)}</option>
          )}
          {ZOOM_STEPS.map((step) => (
            <option key={step} value={String(step)}>
              {formatZoom(step)}
            </option>
          ))}
        </select>
      </div>

      <div className="segmented">
        <button
          type="button"
          className={mode === 'page' ? 'selected' : undefined}
          onClick={() => onMode('page')}
        >
          Single
        </button>
        <button
          type="button"
          className={mode === 'scroll' ? 'selected' : undefined}
          onClick={() => onMode('scroll')}
        >
          Continuous
        </button>
      </div>

      <span className="muted hint">
        ⌘/ctrl + scroll, pinch, or ⌘/ctrl +/− to zoom
      </span>
    </>
  );
}
