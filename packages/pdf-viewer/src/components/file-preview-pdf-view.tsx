import { type Document, open, PasswordError } from '@build-qube/papyra';
import { LockIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PdfIsolationGuard } from '@/components/pdf-isolation-guard';
import { PasswordPrompt } from '@/components/pdf-password-prompt';
import { PdfViewerBasic } from '@/components/pdf-viewer-basic';
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

type State =
  | { status: 'opening' }
  | { status: 'open'; doc: Document }
  | { status: 'password'; retry: boolean }
  | { status: 'locked' }
  | { status: 'failed'; error: unknown };

/**
 * A PDF, opened from the file and shown in the one-page viewer.
 *
 * The other PDF blocks take an open `Document` and leave opening to the app, since
 * that means owning a password prompt and a failure policy. A file previewer *is*
 * the thing that owns those, so this one opens the file itself: it asks for a
 * password when papyra says one is needed, and says so when the reader declines.
 *
 * Loaded by `pdfRenderer` — import that, not this, so papyra stays out of the bundle
 * until a PDF is opened.
 */
export function PdfFileView({ file }: FileViewProps) {
  return (
    <PdfIsolationGuard>
      <OpenedPdf file={file} />
    </PdfIsolationGuard>
  );
}

function OpenedPdf({ file }: FileViewProps) {
  // Held with the file it was typed for, so a new file starts without it — rather
  // than being tried once with the old password before an effect clears it.
  const [typed, setTyped] = useState<{ file: File; password: string }>();
  const password = typed?.file === file ? typed.password : undefined;
  const [state, setState] = useState<State>({ status: 'opening' });

  useEffect(() => {
    let live = true;
    setState({ status: 'opening' });
    open(file, { password }).then(
      (doc) => live && setState({ status: 'open', doc }),
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
    };
    // On `typed`, not the string: the same wrong password twice is still two attempts.
  }, [file, typed]);

  switch (state.status) {
    case 'opening':
      return (
        <div className="grid flex-1 place-items-center">
          <Spinner />
        </div>
      );
    case 'open':
      return <PdfViewerBasic className="min-h-0 flex-1" doc={state.doc} />;
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
