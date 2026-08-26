import { useEffect, useImperativeHandle, useRef } from 'react';

export interface PageImageHandle {
  /**
   * Point the `<img>` at freshly encoded bytes and report when the browser has
   * actually decoded and presented them.
   */
  show(
    bytes: Uint8Array,
    mime: string,
  ): Promise<{ decodeMs: number; presentMs: number }>;
}

interface Props {
  ref: React.Ref<PageImageHandle>;
  className?: string;
  alt: string;
}

/**
 * The `<img>` counterpart to {@link PageView}, imperative for the same reason: the
 * encoded bytes and the blob URL stay out of React state.
 *
 * A blob URL is used rather than a data URL because for `<img src>` base64 inflates by
 * a third and puts a multi-megabyte string on the heap. The previous URL is revoked on
 * every swap and on unmount — without that the tab leaks an encoded page per click.
 */
export function PageImageView({ ref, className, alt }: Props) {
  const img = useRef<HTMLImageElement>(null);
  const placeholder = useRef<HTMLDivElement>(null);
  const url = useRef<string | null>(null);

  const revoke = () => {
    if (url.current) {
      URL.revokeObjectURL(url.current);
      url.current = null;
    }
  };

  useEffect(() => revoke, []);

  useImperativeHandle(ref, () => ({
    async show(bytes, mime) {
      const target = img.current;
      if (!target) return { decodeMs: 0, presentMs: 0 };

      // Copy into a plain ArrayBuffer: on the wasm build these bytes live in shared
      // linear memory, and a SharedArrayBuffer-backed view is not a valid BlobPart.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const next = URL.createObjectURL(new Blob([copy], { type: mime }));

      const started = performance.now();
      target.src = next;
      // decode() resolves once the image is decoded and ready to paint — the honest
      // counterpart to putImageData on the canvas path.
      await target.decode().catch(() => undefined);
      const decoded = performance.now();
      // Reveal only once there are real pixels: a src-less <img> is a broken-image
      // box, where an unpainted <canvas> is merely blank.
      target.hidden = false;
      // Hidden, never removed: detaching a node React rendered breaks its
      // reconciliation on the next commit. React does not manage `hidden` on either of
      // these, so it will not fight us for it.
      if (placeholder.current) placeholder.current.hidden = true;

      // Only now is the old URL definitely unused by the element.
      revoke();
      url.current = next;

      return new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() =>
            resolve({
              decodeMs: decoded - started,
              presentMs: performance.now() - decoded,
            }),
          );
        });
      });
    },
  }));

  return (
    <>
      <div ref={placeholder} className="placeholder page-placeholder" />
      <img ref={img} className={className} alt={alt} hidden />
    </>
  );
}
