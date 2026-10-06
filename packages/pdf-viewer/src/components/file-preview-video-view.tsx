import { useFilePreviewMedia } from '@/hooks/use-file-preview-media';
import type { UrlViewProps } from '@/lib/file-preview-core';

/**
 * A video, letterboxed to the area, with the browser's own controls.
 *
 * Loaded by `videoRenderer` — import that, not this, so the view stays out of the
 * bundle until a video is opened.
 */
export function VideoFileView({ url, name, refresh }: UrlViewProps) {
  const media = useFilePreviewMedia({ url, refresh });
  return (
    <div className="flex min-h-0 flex-1 bg-black">
      <video
        {...media}
        aria-label={name}
        className="size-full object-contain"
        controls
        playsInline
        preload="metadata"
      />
    </div>
  );
}
