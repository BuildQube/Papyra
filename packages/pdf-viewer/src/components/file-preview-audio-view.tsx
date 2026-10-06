import { MusicIcon } from 'lucide-react';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from '@/components/ui/empty';
import { useFilePreviewMedia } from '@/hooks/use-file-preview-media';
import type { UrlViewProps } from '@/lib/file-preview-core';

/**
 * A sound file: its name, and the browser's own player.
 *
 * Loaded by `audioRenderer` — import that, not this, so the view stays out of the
 * bundle until an audio file is opened.
 */
export function AudioFileView({ url, name, refresh }: UrlViewProps) {
  const media = useFilePreviewMedia({ url, refresh });
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MusicIcon />
        </EmptyMedia>
        <EmptyDescription className="wrap-anywhere">{name}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent className="w-full max-w-md">
        <audio {...media} aria-label={name} className="w-full" controls />
      </EmptyContent>
    </Empty>
  );
}
