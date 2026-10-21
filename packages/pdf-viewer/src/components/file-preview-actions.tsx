import { createContext, type ReactNode, use } from 'react';
import {
  downloadSource,
  type FileCache,
  type FileSource,
  heldFile,
} from '@/lib/file-preview-source';

/**
 * What the platform does with a previewed file. Not part of any renderer: every
 * format gets the same actions, whether or not something can display it.
 */
export interface FileActions {
  /** Whether `share` can take this file. Asked on render, so it answers at once. */
  canShare: (file: File) => boolean;
  /**
   * Hands the file to the platform's share sheet. Called straight from the tap, in
   * its user activation; a rejection named `AbortError` is the reader cancelling and
   * is not reported.
   */
  share: (file: File) => Promise<void>;
  /** Saves the file when it cannot be shared: not yet in hand, or no share sheet. */
  download: (source: FileSource, cache: FileCache) => Promise<void>;
}

/** The default: an anchor download, and no share. */
export const downloadFileActions: FileActions = {
  canShare: () => false,
  share: (file) => navigator.share({ files: [file] }),
  download: (source, cache) => downloadSource(source, { cache }),
};

/**
 * The Web Share API where it takes files, else the download. For an iOS WKWebView
 * host, where `<a download>` does nothing and the share sheet is how a file is
 * saved. Not the default because desktop Safari and Chrome take files too, and
 * the macOS sheet has no plain save to disk.
 */
export const shareFileActions: FileActions = {
  ...downloadFileActions,
  canShare: (file) =>
    globalThis.navigator?.canShare?.({ files: [file] }) ?? false,
};

const FileActionsContext = createContext<FileActions>(downloadFileActions);

/** Props for {@link FileActionsProvider}. */
export interface FileActionsProviderProps {
  /**
   * Replaces the default actions it names; the rest stay the download. Pass
   * `shareFileActions` to share where the platform can, or your own `share`.
   */
  actions: Partial<FileActions>;
  /** The tree whose file previews use them. */
  children: ReactNode;
}

/**
 * Sets what every file preview below it does to share and download a file. With
 * none, previews download.
 */
export function FileActionsProvider({
  actions,
  children,
}: FileActionsProviderProps) {
  return (
    <FileActionsContext value={{ ...downloadFileActions, ...actions }}>
      {children}
    </FileActionsContext>
  );
}

/** What a share-or-download button does for one file, decided before the tap. */
export interface FileAction {
  /** Which it will do, for the button's icon and label. */
  kind: 'share' | 'download';
  /** Does it. Never rejects for a cancelled share sheet. */
  run: () => Promise<void>;
}

/**
 * Share when the bytes are in hand and the platform takes them, else download.
 *
 * Only a file already held can be shared: `share()` needs the tap's user activation,
 * which a download awaited after the tap has used up.
 */
export function fileAction(
  actions: FileActions,
  source: FileSource,
  cache: FileCache,
): FileAction {
  const file = heldFile(source, cache);
  if (file && actions.canShare(file)) {
    return {
      kind: 'share',
      run: () =>
        actions.share(file).catch((error: unknown) => {
          if ((error as Error | undefined)?.name !== 'AbortError') throw error;
        }),
    };
  }
  return { kind: 'download', run: () => actions.download(source, cache) };
}

/** {@link fileAction} with the actions in scope. */
export function useFileAction(
  source: FileSource,
  cache: FileCache,
): FileAction {
  return fileAction(use(FileActionsContext), source, cache);
}
