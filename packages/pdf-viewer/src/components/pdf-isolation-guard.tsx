import { TriangleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

/** Props for {@link PdfIsolationGuard}. */
export interface PdfIsolationGuardProps {
  /** The viewer, rendered only when the page can actually run wasm. */
  children: ReactNode;
  /** Replaces the built-in explanation, for apps that word their own errors. */
  fallback?: ReactNode;
}

/**
 * Refuses to render a viewer on a page that cannot run one, and says why.
 *
 * papyra's browser build uses shared wasm memory, so `SharedArrayBuffer` has to
 * exist, so the document has to be cross-origin isolated. Without the two response
 * headers below the module never starts — and the symptom is a blank area and a
 * console message nobody reads, which is a bad hour for someone who just installed
 * this. The check is one boolean and turns that hour into a two-line config change.
 *
 * The headers have to come from whatever serves the app:
 *
 * ```
 * Cross-Origin-Opener-Policy: same-origin
 * Cross-Origin-Embedder-Policy: require-corp
 * ```
 *
 * In Vite that is `server.headers` and `preview.headers`. A static host that cannot
 * set headers at all — GitHub Pages, say — needs a service worker to add them;
 * `coi-serviceworker` is the usual one.
 */
export function PdfIsolationGuard({
  children,
  fallback,
}: PdfIsolationGuardProps) {
  // Not state: it cannot change without a reload, so subscribing to it would be a
  // hook that never fires.
  if (globalThis.crossOriginIsolated) return <>{children}</>;
  if (fallback) return <>{fallback}</>;

  return (
    <Alert variant="destructive" className="m-4 w-auto">
      <TriangleAlertIcon />
      <AlertTitle>This page is not cross-origin isolated</AlertTitle>
      <AlertDescription>
        papyra renders in WebAssembly with shared memory, which needs
        <code>SharedArrayBuffer</code>. Serve this page with
        <code>Cross-Origin-Opener-Policy: same-origin</code> and
        <code>Cross-Origin-Embedder-Policy: require-corp</code>, then reload.
      </AlertDescription>
    </Alert>
  );
}
