import { createContext, use } from 'react';

/**
 * Opens the document-properties dialog the root shell owns.
 *
 * The dialog needs the file name and byte length, which only the shell has — it
 * did the loading — while the request to open it comes from the viewer route's
 * toolbar, two levels down. A context carrying one callback is the whole bridge;
 * routing a boolean through the URL for a modal would be more machinery than the
 * modal.
 */
export const ShowPropertiesContext = createContext<(() => void) | null>(null);

/** The opener, or null outside the shell (the standalone docs routes). */
export function useShowProperties(): (() => void) | null {
  return use(ShowPropertiesContext);
}
