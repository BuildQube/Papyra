import type { EncodedFormat } from '@build-qube/papyra';

const FORMATS: readonly EncodedFormat[] = ['webp', 'png', 'jpeg', 'svg'];

/**
 * WebP here is lossless VP8L and PNG is Deflate — neither takes a quality setting, so
 * the slider hides rather than sitting inert.
 */
const isLossy = (format: EncodedFormat) => format === 'jpeg';

const BLURB: Record<EncodedFormat, string> = {
  webp: 'Lossless, so there is nothing to trade away.',
  png: 'Lossless, so there is nothing to trade away.',
  jpeg: 'Lossy. The only pure-Rust option with a quality knob.',
  svg: 'Vector. Paths stay paths, so it scales without resampling — and width does not apply.',
};

interface Props {
  format: EncodedFormat;
  quality: number;
  width: number;
  transparent: boolean;
  busy: boolean;
  onFormat: (format: EncodedFormat) => void;
  onQuality: (quality: number) => void;
  onWidth: (width: number) => void;
  onTransparent: (transparent: boolean) => void;
  onDownload: () => void;
}

export function ExportControls({
  format,
  quality,
  width,
  transparent,
  busy,
  onFormat,
  onQuality,
  onWidth,
  onTransparent,
  onDownload,
}: Props) {
  return (
    <section className="controls">
      <header>
        <h2>Encode</h2>
      </header>

      <fieldset>
        <legend>format</legend>
        <div className="segmented">
          {FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              className={f === format ? 'selected' : undefined}
              onClick={() => onFormat(f)}
            >
              {f}
            </button>
          ))}
        </div>
        <p className="muted">{BLURB[format]}</p>
      </fieldset>

      {isLossy(format) && (
        <fieldset>
          <legend>quality {quality}</legend>
          <input
            type="range"
            min={1}
            max={100}
            value={quality}
            onChange={(e) => onQuality(Number(e.target.value))}
          />
        </fieldset>
      )}

      {format === 'svg' && (
        <fieldset>
          <legend>background</legend>
          <div className="segmented">
            <button
              type="button"
              className={transparent ? undefined : 'selected'}
              onClick={() => onTransparent(false)}
            >
              white
            </button>
            <button
              type="button"
              className={transparent ? 'selected' : undefined}
              onClick={() => onTransparent(true)}
            >
              transparent
            </button>
          </div>
          <p className="muted">
            White matches how pages rasterise. Drop it when the SVG goes on top
            of something else — the checkerboard is the viewer, not the file.
          </p>
        </fieldset>
      )}

      {format !== 'svg' && (
        <fieldset>
          <legend>width</legend>
          <input
            type="number"
            min={64}
            max={6000}
            step={100}
            value={width}
            onChange={(e) => onWidth(Number(e.target.value))}
          />
          <p className="muted">
            Output pixels, not DPI. A fixed DPI explodes on large-format pages.
          </p>
        </fieldset>
      )}

      <button type="button" onClick={onDownload} disabled={busy}>
        Download .{format === 'jpeg' ? 'jpg' : format}
      </button>
    </section>
  );
}
