import { backend, currentRuntime } from '@build-qube/papyra';
import { Link, Outlet, useMatchRoute, useSearch } from '@tanstack/react-router';
import { usePdfEngine } from '@workspace/pdf-viewer/components/pdf-engine';
import { PasswordPrompt } from '@workspace/pdf-viewer/components/pdf-password-prompt';
import { Properties } from '@workspace/pdf-viewer/components/pdf-properties';
import {
  usePdfDocument,
  usePdfError,
  usePdfPage,
  usePdfPassword,
  usePdfViewerActions,
} from '@workspace/pdf-viewer/hooks/use-pdf-viewer';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@workspace/ui/components/alert';
import { Badge } from '@workspace/ui/components/badge';
import { Button, buttonVariants } from '@workspace/ui/components/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@workspace/ui/components/empty';
import { cn } from '@workspace/ui/lib/utils';
import { FileUpIcon, TriangleAlertIcon, UploadIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import { ShowPropertiesContext } from '../lib/properties.js';
import { useFileParam, usePageUrlSync } from '../lib/urlSync.js';

/**
 * Shell for every route: identity, the file picker, and the nav.
 *
 * Timings are deliberately *not* here — each route measures a different pipeline and
 * renders its own status line in the same place, so the two read as a comparison.
 */
export function RootShell() {
  const loaded = usePdfDocument();
  const error = usePdfError();
  const password = usePdfPassword();
  const { load, cancelPassword } = usePdfViewerActions();
  const [showProperties, setShowProperties] = useState(false);
  const openProperties = useCallback(() => setShowProperties(true), []);
  const [page] = usePdfPage();
  const { file } = useSearch({ strict: false }) as { file?: string };
  useFileParam(file);
  usePageUrlSync();

  const matchRoute = useMatchRoute();
  const engine = usePdfEngine();
  const standalone =
    !!matchRoute({ to: '/docs', fuzzy: true }) ||
    !!matchRoute({ to: '/components' });

  return (
    // `h-dvh`, not `h-screen` (100vh): on mobile Safari 100vh is the height with
    // the address bar hidden, so the bottom of the page sits under it.
    <ShowPropertiesContext value={openProperties}>
      <div className="flex h-dvh flex-col">
        <header className="flex flex-none items-center gap-3 border-b bg-card px-4 py-2.5">
          <h1 className="font-heading text-sm font-semibold tracking-wide">
            papyra
          </h1>
          <Badge variant="secondary">{currentRuntime()}</Badge>
          <Badge variant="secondary">
            {engine.id === 'papyra' ? backend() : engine.id}
          </Badge>

          <nav className="flex items-center gap-1">
            <NavLink to="/" exact>
              viewer
            </NavLink>
            <NavLink to="/export">export</NavLink>
            <NavLink to="/bench">bench</NavLink>
            <NavLink to="/components">components</NavLink>
            <NavLink to="/docs">docs</NavLink>
          </nav>

          {/* A label wearing the button's classes, not a `Button` rendering a label:
            the control has to be a real child of the label for a click on it to open
            the picker, and `buttonVariants` is exported for exactly this case. */}
          <label
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'ml-auto cursor-pointer',
            )}
          >
            <UploadIcon data-icon="inline-start" />
            Open PDF
            <input
              type="file"
              accept="application/pdf"
              className="sr-only"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (picked) void load(picked);
              }}
            />
          </label>

          {loaded && (
            <Button
              variant="link"
              size="sm"
              className="text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
              title="Document properties"
              onClick={() => setShowProperties(true)}
            >
              {loaded.name ?? 'document.pdf'}
            </Button>
          )}

          <a
            className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
            aria-label="GitHub repository"
            href="https://github.com/BuildQube/Papyra"
            target="_blank"
            rel="noopener noreferrer"
          >
            {/* GitHub's mark, unmodified (brand.github.com/foundations/logo): lucide 1.x ships no brand icons. */}
            <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
            </svg>
          </a>
        </header>

        {error && (
          <Alert variant="destructive" className="mx-4 mt-4 w-auto">
            <TriangleAlertIcon />
            <AlertTitle>This PDF could not be opened</AlertTitle>
            <AlertDescription className="font-mono text-xs">
              {error}
            </AlertDescription>
          </Alert>
        )}

        {password ? (
          <PasswordPrompt
            name={password.file.name}
            retry={password.retry}
            onSubmit={(secret) => void load(password.file, secret)}
            onCancel={cancelPassword}
          />
        ) : loaded || standalone ? (
          <Outlet />
        ) : (
          <Dropzone onFile={load} />
        )}

        {loaded && showProperties && (
          <Properties
            doc={loaded.doc}
            name={loaded.name ?? 'document.pdf'}
            byteLength={loaded.bytes?.byteLength ?? 0}
            page={Math.min(page, loaded.doc.pageCount - 1)}
            onClose={() => setShowProperties(false)}
          />
        )}
      </div>
    </ShowPropertiesContext>
  );
}

/**
 * TanStack Router already marks the active link with `data-status="active"`, so the
 * selected state is a variant on the rendered anchor rather than a second source of
 * truth computed alongside the router's.
 */
function NavLink({
  to,
  exact,
  children,
}: {
  to: '/' | '/export' | '/bench' | '/components' | '/docs';
  exact?: boolean;
  children: string;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      // Base UI's Button assumes a native <button> and says so at runtime when it
      // gets anything else; this one renders the router's <a>.
      nativeButton={false}
      className="text-muted-foreground data-[status=active]:bg-muted data-[status=active]:text-foreground"
      render={
        <Link
          to={to}
          search={(prev) => prev}
          activeOptions={{ exact: exact ?? false }}
        />
      }
    >
      {children}
    </Button>
  );
}

function Dropzone({ onFile }: { onFile: (file: File) => void }) {
  return (
    <section
      aria-label="Drop a PDF to open it"
      className="flex flex-1"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
    >
      <Empty className="m-6 border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileUpIcon />
          </EmptyMedia>
          <EmptyTitle>Drop a PDF here</EmptyTitle>
          <EmptyDescription>
            …or use “Open PDF”. Rendered by hayro compiled to wasm, running in
            this tab.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
  );
}
