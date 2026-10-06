import {
  BanIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileQuestionIcon,
  FilesIcon,
  FileWarningIcon,
} from 'lucide-react';
import {
  Component,
  type ComponentType,
  type ErrorInfo,
  type KeyboardEvent,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useState,
} from 'react';
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
import {
  type Detection,
  detect,
  type FileRenderer,
  type FileViewProps,
  type RendererId,
} from '@/lib/file-preview-core';
import { cn } from '@/lib/utils';

/** Props for {@link FilePreview}, less the renderer list. */
export interface FilePreviewProps<Id extends string = string> {
  /** The files to page through, shown one at a time. */
  files: readonly File[];
  /**
   * The formats this preview may show, by renderer id. Leave it out to allow every
   * renderer given. A file of any other format gets a card saying so, and a download.
   */
  allow?: readonly Id[];
  /** The file on screen, 0-based. Leave it out to let the preview hold its own. */
  index?: number;
  /** The file to start on when uncontrolled. */
  defaultIndex?: number;
  /** Called with the new index, 0-based. */
  onIndexChange?: (index: number) => void;
  /** Classes for the outermost element. */
  className?: string;
}

/**
 * Previews a list of files of mixed types, one at a time, with a pager.
 *
 * Each format comes from a renderer — `file-preview-pdf`, `file-preview-image`,
 * `file-preview-code` — installed separately, so a format you do not install costs
 * no dependency, and one you do costs nothing until a file of that type is opened.
 * Files are recognised by their bytes before their names.
 *
 * `allow` is typed from `renderers`: an id no renderer has is a type error. Usually
 * reached through `createFilePreview`, which binds the list once.
 */
export function FilePreview<const R extends readonly FileRenderer[]>({
  renderers,
  files,
  allow,
  index,
  defaultIndex = 0,
  onIndexChange,
  className,
}: FilePreviewProps<RendererId<R>> & {
  /** The formats this preview knows, in priority order. */
  renderers: R;
}) {
  const [own, setOwn] = useState(defaultIndex);
  const count = files.length;
  const at = Math.max(0, Math.min(index ?? own, count - 1));
  const file = files[at];

  const go = (next: number) => {
    if (next < 0 || next >= count || next === at) return;
    setOwn(next);
    onIndexChange?.(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    // A text field, or a view that has taken the arrows for itself, keeps them.
    if (event.defaultPrevented || isEditable(event.target)) return;
    if (event.key === 'ArrowLeft') go(at - 1);
    else if (event.key === 'ArrowRight') go(at + 1);
    else return;
    event.preventDefault();
  };

  return (
    <section
      aria-label="File preview"
      className={cn('flex min-h-0 min-w-0 flex-col', className)}
      onKeyDown={onKeyDown}
    >
      {file ? (
        <>
          <header className="flex items-center gap-2 border-b px-2 py-1.5">
            {count > 1 && (
              <Button
                aria-label="Previous file"
                disabled={at === 0}
                onClick={() => go(at - 1)}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronLeftIcon />
              </Button>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{file.name}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {count > 1 && `${at + 1} of ${count} · `}
                {formatBytes(file.size)}
              </p>
            </div>
            <Button
              aria-label={`Download ${file.name}`}
              onClick={() => download(file)}
              size="icon-sm"
              variant="ghost"
            >
              <DownloadIcon />
            </Button>
            {count > 1 && (
              <Button
                aria-label="Next file"
                disabled={at === count - 1}
                onClick={() => go(at + 1)}
                size="icon-sm"
                variant="ghost"
              >
                <ChevronRightIcon />
              </Button>
            )}
          </header>
          <FileBody
            allow={allow}
            file={file}
            key={keyOf(file)}
            renderers={renderers}
          />
        </>
      ) : (
        <Notice icon={<FilesIcon />} title="No files to preview" />
      )}
    </section>
  );
}

function FileBody({
  file,
  renderers,
  allow,
}: {
  file: File;
  renderers: readonly FileRenderer[];
  allow: readonly string[] | undefined;
}) {
  const [found, setFound] = useState<Detection>();

  useEffect(() => {
    let live = true;
    detect(file, renderers, allow).then(
      (d) => live && setFound(d),
      () => live && setFound({ status: 'unsupported' }),
    );
    return () => {
      live = false;
    };
    // `allow` by content: an inline array literal is a new array every render.
  }, [file, renderers, allow?.join('\0')]);

  if (!found) return <Loading />;

  switch (found.status) {
    case 'unsupported':
      return (
        <Notice
          action={<DownloadButton file={file} />}
          description={file.name}
          icon={<FileQuestionIcon />}
          title="No preview for this file"
        />
      );
    case 'blocked':
      return (
        <Notice
          action={<DownloadButton file={file} />}
          description={file.name}
          icon={<BanIcon />}
          title={`${found.renderer.label} files are not previewed here`}
        />
      );
    case 'ok': {
      const View = viewOf(found.renderer);
      return (
        <ViewBoundary file={file}>
          <Suspense fallback={<Loading />}>
            <div className="flex min-h-0 flex-1 flex-col">
              <View file={file} />
            </div>
          </Suspense>
        </ViewBoundary>
      );
    }
  }
}

const views = new WeakMap<
  FileRenderer,
  LazyExoticComponent<ComponentType<FileViewProps>>
>();

/**
 * One lazy component per renderer, for the page's lifetime.
 *
 * `lazy` caches its promise on the component it returns, so making a new one per
 * render would mean a new import, and a new suspense, every time a file is shown.
 */
function viewOf(renderer: FileRenderer) {
  let view = views.get(renderer);
  if (!view) {
    const load = renderer.load;
    view = lazy(() => load().then((c) => ({ default: c })));
    views.set(renderer, view);
  }
  return view;
}

/**
 * Turns a view that throws — a corrupt PDF, a chunk that failed to load — into a
 * card for that one file, so the pager still works and the next file still opens.
 */
class ViewBoundary extends Component<
  { file: File; children: ReactNode },
  { error: unknown }
> {
  override state: { error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('file preview: view failed', error, info.componentStack);
  }

  override render() {
    const { error } = this.state;
    if (error === undefined) return this.props.children;
    return (
      <Notice
        action={<DownloadButton file={this.props.file} />}
        description={error instanceof Error ? error.message : String(error)}
        icon={<FileWarningIcon />}
        title="This file could not be opened"
      />
    );
  }
}

function Notice({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && (
          <EmptyDescription className="wrap-anywhere">
            {description}
          </EmptyDescription>
        )}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

function Loading() {
  return (
    <div className="grid flex-1 place-items-center">
      <Spinner />
    </div>
  );
}

function DownloadButton({ file }: { file: File }) {
  return (
    <Button onClick={() => download(file)} variant="outline">
      <DownloadIcon />
      Download
    </Button>
  );
}

function download(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  // Revoked on the next task, not now: the click starts the download asynchronously
  // and a URL revoked under it fails in Firefox.
  setTimeout(() => URL.revokeObjectURL(url));
}

const keys = new WeakMap<File, number>();
let nextKey = 0;

/**
 * A stable key per file object. Not the index — replacing the list puts a different
 * file at the same position, and its view must start fresh, error state included.
 */
function keyOf(file: File): number {
  let key = keys.get(file);
  if (key === undefined) {
    key = nextKey++;
    keys.set(file, key);
  }
  return key;
}

function isEditable(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
