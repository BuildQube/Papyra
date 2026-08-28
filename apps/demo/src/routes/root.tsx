import { backend, currentRuntime } from '@build-qube/papyra';
import { Link, Outlet, useMatchRoute, useSearch } from '@tanstack/react-router';
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
import { useState } from 'react';
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
  const [page] = usePdfPage();
  const { file } = useSearch({ strict: false }) as { file?: string };
  useFileParam(file);
  usePageUrlSync();

  const matchRoute = useMatchRoute();
  const standalone =
    !!matchRoute({ to: '/docs' }) || !!matchRoute({ to: '/components' });

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-none items-center gap-3 border-b bg-card px-4 py-2.5">
        <h1 className="font-heading text-sm font-semibold tracking-wide">
          papyra
        </h1>
        <Badge variant="secondary">{currentRuntime()}</Badge>
        <Badge variant="secondary">{backend()}</Badge>

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
