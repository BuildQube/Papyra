import type { PdfEngine } from '@build-qube/papyra/core';
import { TriangleAlertIcon } from 'lucide-react';
import { createContext, type ReactNode, use, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { fallbackPdfEngine } from '@/lib/pdf-default-engine';

/**
 * The engine in scope. papyra's own when no provider is mounted, so every viewer works
 * without one — and since that is the instance `open()` uses, a `Document` the app
 * opened itself is one the viewer's commands accept. `pdf-default-engine` says how
 * to keep papyra's wasm out of an app that never uses it.
 */
const PdfEngineContext = createContext<PdfEngine>(fallbackPdfEngine);

/** Props for {@link PdfEngineProvider}. */
export interface PdfEngineProviderProps {
  /**
   * The engine every viewer below opens and renders through, or a list to pick from:
   * the first whose `availability()` is ok wins, so `[papyra, pdfjs]` falls back to
   * pdf.js on a page that is not cross-origin isolated.
   */
  engine: PdfEngine | readonly PdfEngine[];
  /** The tree that renders PDFs. */
  children: ReactNode;
}

/**
 * Chooses the engine for every PDF viewer below it.
 *
 * Chosen once, on mount. A document belongs to the engine that opened it, so switching
 * engines under an open one would strand it; a later change to `engine` is ignored.
 */
export function PdfEngineProvider({
  engine,
  children,
}: PdfEngineProviderProps) {
  const [chosen] = useState(() => {
    const list = ([] as PdfEngine[]).concat(engine);
    // None available: keep the first, so the guard can say why it cannot run.
    return (
      list.find((e) => e.availability().ok) ?? list[0] ?? fallbackPdfEngine
    );
  });
  return <PdfEngineContext value={chosen}>{children}</PdfEngineContext>;
}

/**
 * The engine in scope: what a viewer opens files with and sends every command
 * through — `engine.render(doc, …)`, `engine.search(doc, …)`.
 */
export function usePdfEngine(): PdfEngine {
  return use(PdfEngineContext);
}

/** Props for {@link PdfEngineGuard}. */
export interface PdfEngineGuardProps {
  /** The viewer, rendered only when the engine in scope can run here. */
  children: ReactNode;
  /** Replaces the engine's own explanation, for apps that word their own errors. */
  fallback?: ReactNode;
}

/**
 * Refuses to render a viewer the engine in scope cannot run, and says why in the
 * engine's own words.
 *
 * For papyra's engine that is a page without cross-origin isolation: the wasm build
 * uses shared memory, so without `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp` it never starts, and the symptom
 * is otherwise a blank area and a console message nobody reads. An engine that needs
 * no such thing — pdf.js, or a native one inside an app shell — is always let through.
 */
export function PdfEngineGuard({ children, fallback }: PdfEngineGuardProps) {
  // Not state: availability cannot change without a reload.
  const available = usePdfEngine().availability();
  if (available.ok) return <>{children}</>;
  if (fallback) return <>{fallback}</>;

  return (
    <Alert variant="destructive" className="m-4 w-auto">
      <TriangleAlertIcon />
      <AlertTitle>{available.title}</AlertTitle>
      <AlertDescription>{available.reason}</AlertDescription>
    </Alert>
  );
}
