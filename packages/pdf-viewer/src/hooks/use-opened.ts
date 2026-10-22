import { useEffect, useState } from 'react';

/** Where a {@link useOpened} file stands. */
export type Opened<T> =
  | {
      /** Not open yet. */
      status: 'opening';
    }
  | {
      /** Open, and closed when replaced or unmounted. */
      status: 'open';
      /** What `open` resolved to. */
      value: T;
    }
  | {
      /** `open` rejected. */
      status: 'failed';
      /** Its reason. */
      error: unknown;
    };

/**
 * Open something that holds resources until closed — a document, a TIFF, a
 * workbook — and close it when it is replaced or the view goes away.
 *
 * A host holding the file, such as a Tauri app's, keeps it until the page reloads
 * unless it is closed, so this covers the race too: a file that finishes opening
 * after `open` changed or the view unmounted is closed rather than shown.
 *
 * @param open Opens the file. Reopens whenever its identity changes, so pass a
 *   stable function — `useCallback` over what it reads.
 * @param close Frees what `open` gave. Stable too; a failure is ignored, as the
 *   view is already done with it.
 */
export function useOpened<T>(
  open: () => Promise<T>,
  close: (value: T) => Promise<unknown>,
): Opened<T> {
  const [opened, setOpened] = useState<Opened<T>>({ status: 'opening' });

  useEffect(() => {
    let live = true;
    setOpened({ status: 'opening' });
    open().then(
      (value) => {
        // Opened after `open` changed or the view went away: nobody shows it.
        if (!live) return void close(value).catch(() => {});
        setOpened({ status: 'open', value });
      },
      (error: unknown) => live && setOpened({ status: 'failed', error }),
    );
    return () => {
      live = false;
    };
  }, [open, close]);

  const value = opened.status === 'open' ? opened.value : undefined;
  useEffect(() => {
    if (value === undefined) return;
    return () => {
      close(value).catch(() => {});
    };
  }, [value, close]);

  return opened;
}
