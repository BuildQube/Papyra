import { createContext, type ReactNode, use } from 'react';
import {
  downloadSource,
  type FileCache,
  type FileSource,
  heldFile,
} from '@/lib/file-preview-source';

const ShareContext = createContext(false);
const DownloadContext = createContext<FileDownload | undefined>(undefined);

/** A host's own download, given the file a preview would have saved. */
export type FileDownload = (source: FileSource) => void | Promise<void>;

/** Props for {@link FileActionsProvider}. */
export interface FileActionsProviderProps {
  /**
   * Share instead of downloading where the platform takes files. For an iOS
   * WKWebView host, where `<a download>` does nothing and the share sheet is how a
   * file is saved. Off by default because desktop Safari and Chrome take files
   * too, and the macOS sheet has no plain save to disk.
   */
  share?: boolean;
  /**
   * Saves the file instead of the preview, for a host that has to own the download
   * — to write an audit row, or to re-sign the URL. Replaces sharing as well: the
   * button always downloads, through this.
   */
  onDownload?: FileDownload;
  /** The tree whose file previews it applies to. */
  children: ReactNode;
}

/**
 * Sets whether every file preview below it shares or downloads a file, and who does
 * the download. With none,
 * previews download. Not part of any renderer: every format gets the same actions,
 * whether or not something can display it.
 */
export function FileActionsProvider({
  share = false,
  onDownload,
  children,
}: FileActionsProviderProps) {
  return (
    <ShareContext value={share}>
      <DownloadContext value={onDownload}>{children}</DownloadContext>
    </ShareContext>
  );
}

/** What a share-or-download button does for one file. */
export interface FileAction {
  /** Which it would do now, for the button's icon and label. */
  kind: 'share' | 'download';
  /**
   * Does it, deciding again at the tap: the file may have arrived since render. A
   * cancelled share sheet is not an error; a share that fails downloads instead.
   */
  run: () => Promise<void>;
}

/**
 * Share when sharing is on, the bytes are in hand and the platform takes them, else
 * download.
 *
 * Only a file already held can be shared: `share()` needs the tap's user activation,
 * which a download awaited after the tap has used up. So everything before
 * `navigator.share` is synchronous.
 *
 * @param share Whether sharing is on.
 * @param source The file.
 * @param cache Where downloaded files are kept.
 * @param held The file itself, when the caller holds it — one too large for the
 *   cache is still shareable from the view that has it.
 * @param download The host's own download, which replaces both.
 */
export function fileAction(
  share: boolean,
  source: FileSource,
  cache: FileCache,
  held?: File,
  download?: FileDownload,
): FileAction {
  if (download) return { kind: 'download', run: async () => download(source) };
  const shareable = () => {
    if (!share) return undefined;
    const file = held ?? heldFile(source, cache);
    return file && globalThis.navigator?.canShare?.({ files: [file] })
      ? file
      : undefined;
  };
  return {
    kind: shareable() ? 'share' : 'download',
    run: async () => {
      const file = shareable();
      if (file) {
        try {
          return await navigator.share({ files: [file] });
        } catch (error) {
          if ((error as Error | undefined)?.name === 'AbortError') return;
        }
      }
      await downloadSource(source, { cache });
    },
  };
}

/** {@link fileAction} with the provider's settings in scope. */
export function useFileAction(
  source: FileSource,
  cache: FileCache,
  held?: File,
): FileAction {
  return fileAction(
    use(ShareContext),
    source,
    cache,
    held,
    use(DownloadContext),
  );
}
