import type {
  EncodedFormat,
  EncodedImage,
  JobTiming,
  RasterFormat,
} from '@build-qube/papyra';
import { PageImage } from '@build-qube/papyra';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExportControls } from '../components/ExportControls.js';
import {
  type PageImageHandle,
  PageImageView,
} from '../components/PageImageView.js';
import { ViewerLayout } from '../components/ViewerLayout.js';
import { useDocument } from '../lib/documentContext.js';
import { PAGE } from '../lib/pageClass.js';
import { usePage } from '../lib/usePage.js';
import { defaultViewWidth } from '../lib/width.js';

interface Timing {
  /** Queued behind other work before this render started. */
  wait: number;
  /** Actually rasterising. */
  run: number;
  /** Bitmap -> encoded bytes, inside wasm. Zero on the SVG path: it emits text. */
  encode: number;
  /** The browser decoding those bytes back into pixels. */
  decode: number;
  /** Decoded until the compositor showed the frame. */
  present: number;
  /** Request until the image was actually on screen. */
  visible: number;
  /** Encoded size, and the raw bitmap it replaced — `null` when there was none. */
  bytes: number;
  raw: number | null;
  width: number;
  height: number;
}

interface Search {
  format?: EncodedFormat;
  quality?: number;
  width?: number;
  transparent?: boolean;
}

/**
 * The encoded-image path: render, encode in wasm, hand the browser a blob URL.
 *
 * Deliberately the same layout, page and width as the viewer — the only difference is
 * how the pixels reach the screen. The canvas route wins on time to first pixel because
 * it never decodes anything; this route wins by more than an order of magnitude on
 * bytes, which is what matters the moment the pixels leave the process.
 */
export function ExportRoute() {
  const { loaded, setError } = useDocument();
  const [page] = usePage();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Search;

  const format = search.format ?? 'webp';
  /** What `PageImage.encode` will be asked for; unused on the SVG path. */
  const rasterFormat: RasterFormat = format === 'svg' ? 'webp' : format;
  const quality = search.quality ?? 80;
  const width = search.width ?? defaultViewWidth();
  const transparent = search.transparent ?? false;

  const view = useRef<PageImageHandle>(null);
  // Held for the download button. A ref, not state: re-rendering on every encode would
  // put the bytes through React for no reason.
  const encoded = useRef<EncodedImage | null>(null);
  const [timing, setTiming] = useState<Timing | null>(null);
  const [busy, setBusy] = useState(false);

  const doc = loaded?.doc;

  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    const started = performance.now();
    setTiming(null);
    setBusy(true);

    /** Everything after the bytes exist, which is all the two paths share. */
    const present = async (
      job: JobTiming | null,
      out: EncodedImage,
      encodeMs: number,
      raster: PageImage | null,
    ) => {
      encoded.current = out;
      const shown = (await view.current?.show(out.bytes, out.mime)) ?? {
        decodeMs: 0,
        presentMs: 0,
      };
      if (cancelled) return;

      const size = doc.pageSize(page);
      setTiming({
        wait: job?.waitMs ?? 0,
        run: job?.runMs ?? 0,
        encode: encodeMs,
        decode: shown.decodeMs,
        present: shown.presentMs,
        visible: performance.now() - started,
        bytes: out.bytes.length,
        raw: raster?.byteLength ?? null,
        width: Math.round(raster?.width ?? size.width),
        height: Math.round(raster?.height ?? size.height),
      });
    };

    // SVG is not an encoding of a bitmap: it comes off the page directly, so there is
    // no width to render at, no quality to trade, and no raw buffer to compare with.
    const job =
      format === 'svg'
        ? doc.svgHandle(page, {
            priority: 0,
            background: transparent ? 'transparent' : 'white',
          })
        : doc.imageHandle(page, { fitWidth: width, priority: 0 });

    const settle = async () => {
      const result = await job.promise;
      if (cancelled) return;

      if (!(result instanceof PageImage)) {
        await present(job.timing, result, 0, null);
        return;
      }
      const encodeStarted = performance.now();
      const out = await result.encode({ format: rasterFormat, quality });
      if (cancelled) return;
      await present(job.timing, out, performance.now() - encodeStarted, result);
    };

    settle()
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setBusy(false));

    return () => {
      cancelled = true;
      job.cancel('left the page');
    };
  }, [doc, page, width, format, rasterFormat, quality, transparent, setError]);

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

  const download = useCallback(() => {
    const out = encoded.current;
    if (!out || !loaded) return;
    const url = out.toBlobUrl();
    const a = document.createElement('a');
    a.href = url;
    a.download = `${loaded.name.replace(/\.pdf$/i, '')}-p${page + 1}.${
      format === 'jpeg' ? 'jpg' : format
    }`;
    a.click();
    URL.revokeObjectURL(url);
  }, [loaded, page, format]);

  return (
    <ViewerLayout
      status={
        timing && (
          <span className="text-xs text-muted-foreground">
            {format} · page {page + 1} · {timing.width}×{timing.height}
            {timing.raw === null ? ' pt' : ''} · wait {timing.wait.toFixed(0)} ·
            run {timing.run.toFixed(0)} · encode {timing.encode.toFixed(0)} ·
            decode {timing.decode.toFixed(0)} · present{' '}
            {timing.present.toFixed(0)} ·{' '}
            <strong>{(timing.bytes / 1024).toFixed(0)} KB</strong>
            {timing.raw !== null &&
              ` vs ${(timing.raw / 1e6).toFixed(1)} MB raw (${(
                timing.raw / timing.bytes
              ).toFixed(0)}× smaller)`}{' '}
            · <strong>visible {timing.visible.toFixed(0)}ms</strong>
          </span>
        )
      }
      aside={
        <ExportControls
          format={format}
          quality={quality}
          width={width}
          transparent={transparent}
          busy={busy}
          onFormat={(f) => patch({ format: f })}
          onQuality={(q) => patch({ quality: q })}
          onWidth={(w) => patch({ width: w })}
          onTransparent={(t) => patch({ transparent: t })}
          onDownload={download}
        />
      }
    >
      <PageImageView
        ref={view}
        className={cn(PAGE, transparent && format === 'svg' && 'checkerboard')}
        alt={`Page ${page + 1} encoded as ${format}`}
      />
    </ViewerLayout>
  );
}
