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

/**
 * The Web Share API where it takes files — iOS WKWebView included, which is the
 * whole implementation there, since `<a download>` does nothing in it — else an
 * anchor download.
 */
export const webFileActions: FileActions = {
  canShare: (file) =>
    globalThis.navigator?.canShare?.({ files: [file] }) ?? false,
  share: (file) => navigator.share({ files: [file] }),
  download: (source, cache) => downloadSource(source, { cache }),
};

const FileActionsContext = createContext<FileActions>(webFileActions);

/** Props for {@link FileActionsProvider}. */
export interface FileActionsProviderProps {
  /** Replaces the default actions it names; the rest stay the web's. */
  actions: Partial<FileActions>;
  /** The tree whose file previews use them. */
  children: ReactNode;
}

/** Sets what every file preview below it does to share and download a file. */
export function FileActionsProvider({
  actions,
  children,
}: FileActionsProviderProps) {
  return (
    <FileActionsContext value={{ ...webFileActions, ...actions }}>
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
