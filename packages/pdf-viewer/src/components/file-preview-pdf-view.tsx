import { PasswordError, type PdfDoc } from '@build-qube/papyra/core';
import { LockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PdfEngineGuard, usePdfEngine } from '@/components/pdf-engine';
import { PasswordPrompt } from '@/components/pdf-password-prompt';
import {
  PdfViewerConfigurable,
  type PdfViewerConfigurableProps,
} from '@/components/pdf-viewer-configurable';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import type { FileViewProps } from '@/lib/file-preview-core';

/**
 * What a preview may set for its PDFs: every feature of the configurable viewer.
 *
 * `fullscreen` is left out because the preview offers its own, and two expand
 * buttons one above the other would fill different amounts of nothing. `fileName`
 * and `fileSize` come from the file itself. The properties dialog shows the size
 * whatever the preview's `displaySize` says: there it is the thing asked for.
 */
export type PdfFileViewOptions = Omit<
  PdfViewerConfigurableProps,
  'doc' | 'store' | 'className' | 'fullscreen' | 'fileName' | 'fileSize'
>;

type State =
  | { status: 'opening' }
  | { status: 'open'; doc: PdfDoc; file: File }
  | { status: 'password'; retry: boolean }
  | { status: 'locked' }
  | { status: 'failed'; error: unknown };

/**
 * A PDF, opened from the file and shown in the configurable viewer — a continuous
 * scrolling column with nothing else unless `options` turns on more.
 *
 * The other PDF blocks take an open document and leave opening to the app, since
 * that means owning a password prompt and a failure policy. A file previewer *is*
 * the thing that owns those, so this one opens the file itself: it asks for a
 * password when the engine says one is needed, and says so when the reader declines.
 * It closes what it opened, when the file changes and on unmount.
 *
 * Loaded by `pdfRenderer` — import that, not this, so papyra stays out of the bundle
 * until a PDF is opened.
 */
export function PdfFileView(props: FileViewProps<PdfFileViewOptions>) {
  return (
    <PdfEngineGuard>
      <OpenedPdf {...props} />
    </PdfEngineGuard>
  );
}

function OpenedPdf({
  file,
  options,
  displayRenderTime,
}: FileViewProps<PdfFileViewOptions>) {
  // Held with the file it was typed for, so a new file starts without it — rather
  // than being tried once with the old password before an effect clears it.
  const [typed, setTyped] = useState<{ file: File; password: string }>();
  const password = typed?.file === file ? typed.password : undefined;
  const engine = usePdfEngine();
  const [current, setState] = useState<State>({ status: 'opening' });
  // A document opened for another file is never shown, not even for the render
  // before the effect below catches up: by then that effect has closed it.
  const state =
    current.status === 'open' && current.file !== file
      ? { status: 'opening' as const }
      : current;

  useEffect(() => {
    let live = true;
    let opened: PdfDoc | undefined;
    setState({ status: 'opening' });
    engine.open(file, { password }).then(
      (doc) => {
        if (!live) return engine.close(doc);
        opened = doc;
        setState({ status: 'open', doc, file });
      },
      (error: unknown) => {
        if (!live) return;
        setState(
          error instanceof PasswordError
            ? { status: 'password', retry: error.retry }
            : { status: 'failed', error },
        );
      },
    );
    return () => {
      live = false;
      // After the viewer below has unmounted: React runs a child's cleanups first.
      if (opened) engine.close(opened);
    };
    // On `typed`, not the string: the same wrong password twice is still two attempts.
  }, [engine, file, typed]);

  switch (state.status) {
    case 'opening':
      return (
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      );
    case 'open':
      return (
        <PdfViewerConfigurable
          // Continuous unless asked otherwise: a previewed file is read through,
          // not paged, and scrolling is what every other format here does.
          view="scroll"
          displayRenderTime={displayRenderTime}
          {...options}
          className="min-h-0 flex-1"
          doc={state.doc}
          fileName={file.name}
          fileSize={file.size}
          fullscreen={false}
        />
      );
    case 'password':
      return (
        <PasswordPrompt
          name={file.name}
          onCancel={() => setState({ status: 'locked' })}
          onSubmit={(p) => setTyped({ file, password: p })}
          retry={state.retry}
        />
      );
    case 'locked':
      return (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockIcon />
            </EmptyMedia>
            <EmptyTitle>This PDF is locked</EmptyTitle>
            <EmptyDescription className="wrap-anywhere">
              {file.name}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              onClick={() => setState({ status: 'password', retry: false })}
              variant="outline"
            >
              Enter password
            </Button>
          </EmptyContent>
        </Empty>
      );
    case 'failed':
      // To the preview's error boundary, which already knows how to say a file could
      // not be opened and offer it as a download.
      throw state.error;
  }
}
