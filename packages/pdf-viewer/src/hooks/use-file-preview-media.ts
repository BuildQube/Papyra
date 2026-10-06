import { type SyntheticEvent, useEffect, useRef, useState } from 'react';
import type { UrlViewProps } from '@/lib/file-preview-core';

/** Spread onto a `<video>` or `<audio>`. */
export interface MediaSourceProps {
  /** The URL to play — the one given, or a refreshed one after an error. */
  src: string;
  /**
   * Always `'anonymous'`. papyra's pages are cross-origin isolated, and under
   * `Cross-Origin-Embedder-Policy: require-corp` a cross-origin media element loads
   * only in CORS mode — the same CORS the download path already needs.
   */
  crossOrigin: 'anonymous';
  /** Refreshes the URL once, then gives up to the preview's error card. */
  onError: (event: SyntheticEvent<HTMLMediaElement>) => void;
  /** Puts playback back where it was after a refresh. */
  onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => void;
}

/** What went wrong, in the reader's terms. `MediaError` codes are 1–4. */
function describe(el: HTMLMediaElement): Error {
  switch (el.error?.code) {
    case 2:
      return new Error('The file stopped downloading part-way.');
    case 3:
      return new Error(
        'The file is damaged, or uses an encoding this browser cannot decode.',
      );
    default:
      // 4 covers both an unsupported format and a URL that no longer answers: a
      // media element is told nothing more specific than that.
      return new Error(
        'This browser could not play this file. Its format may not be supported here, or its link may have stopped working.',
      );
  }
}

/**
 * A media element's `src`, refreshed once when playback fails.
 *
 * A signed link can expire while a long video is still playing, and a media element
 * reports that with the same error as a format it cannot play. So any error gets one
 * fresh URL from `refresh()`, and playback resumes at the same position; a second
 * error in a row is real, and is thrown to the preview's error boundary. A load that
 * succeeds resets the allowance, so a link that expires again an hour later is
 * refreshed again.
 */
export function useFilePreviewMedia({
  url,
  refresh,
}: Pick<UrlViewProps, 'url' | 'refresh'>): MediaSourceProps {
  const [src, setSrc] = useState(url);
  const [failed, setFailed] = useState<Error>();
  const retried = useRef(false);
  const resume = useRef<{ at: number; playing: boolean } | null>(null);

  useEffect(() => {
    setSrc(url);
    setFailed(undefined);
    retried.current = false;
  }, [url]);

  if (failed) throw failed;

  return {
    src,
    crossOrigin: 'anonymous',
    onError: (event) => {
      const el = event.currentTarget;
      if (retried.current) {
        setFailed(describe(el));
        return;
      }
      retried.current = true;
      resume.current = { at: el.currentTime, playing: !el.paused };
      refresh().then(
        (next) => (next === src ? setFailed(describe(el)) : setSrc(next)),
        () => setFailed(describe(el)),
      );
    },
    onLoadedMetadata: (event) => {
      const el = event.currentTarget;
      retried.current = false;
      const at = resume.current;
      resume.current = null;
      if (!at || at.at <= 0) return;
      el.currentTime = at.at;
      if (at.playing) void el.play().catch(() => undefined);
    },
  };
}
