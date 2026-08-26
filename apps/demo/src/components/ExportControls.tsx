import type { EncodedFormat } from '@build-qube/papyra';

const FORMATS: readonly EncodedFormat[] = ['webp', 'png', 'jpeg'];

/**
 * WebP here is lossless VP8L and PNG is Deflate — neither takes a quality setting, so
 * the slider hides rather than sitting inert.
 */
const isLossy = (format: EncodedFormat) => format === 'jpeg';

interface Props {
  format: EncodedFormat;
  quality: number;
  width: number;
  busy: boolean;
  onFormat: (format: EncodedFormat) => void;
  onQuality: (quality: number) => void;
  onWidth: (width: number) => void;
  onDownload: () => void;
}

export function ExportControls({
  format,
  quality,
  width,
  busy,
  onFormat,
  onQuality,
  onWidth,
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
        <p className="muted">
          {isLossy(format)
            ? 'Lossy. The only pure-Rust option with a quality knob.'
            : 'Lossless, so there is nothing to trade away.'}
        </p>
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

      <button type="button" onClick={onDownload} disabled={busy}>
        Download .{format === 'jpeg' ? 'jpg' : format}
      </button>
    </section>
  );
}
