import {
  BanIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloudOffIcon,
  DownloadIcon,
  FileQuestionIcon,
  FilesIcon,
  FileWarningIcon,
  MaximizeIcon,
  MinimizeIcon,
  RotateCwIcon,
  ShieldXIcon,
} from 'lucide-react';
import {
  Component,
  type ErrorInfo,
  type KeyboardEvent,
  type LazyExoticComponent,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useRef,
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
import { useFullscreen } from '@/hooks/use-fullscreen';
import {
  detectHead,
  type FileInputRenderer,
  type FileRenderer,
  type FileView,
  type RendererId,
  type RendererOptions,
  type UrlInputRenderer,
  type UrlView,
} from '@/lib/file-preview-core';
import {
  defaultFileCache,
  downloadSource,
  type FileCache,
  type FileSource,
  inspectSource,
  resolveFile,
  resolveUrl,
  SourceError,
  type SourceInfo,
  sourceInfo,
  sourceKey,
} from '@/lib/file-preview-source';
import { cn } from '@/lib/utils';

/**
 * Props for {@link FilePreview}, less the renderer list.
 *
 * `Options` is the shape of `options`; `createFilePreview` fills it in from the
 * renderers it was given, so each entry is checked against that renderer's view.
 */
export interface FilePreviewProps<
  Id extends string = string,
  Options extends object = { readonly [K in Id]?: object },
> {
  /**
   * The files to page through, shown one at a time: `File`s, URLs, or
   * `{ key, url }` sources whose `url` may be a function that mints a signed link.
   * Remote files are fetched when shown, kept in the cache, and never fetched twice.
   */
  files: readonly FileSource[];
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
  /**
   * Where downloaded files are kept. Defaults to one cache shared by every preview
   * on the page, bounded at 256 MiB; pass a `FileCache` to size or clear your own.
   */
  cache?: FileCache;
  /**
   * Options for each format's view, by renderer id — `{ pdf: { thumbnails: true } }`.
   * Merged over whatever the renderer was given with `with`, field by field.
   */
  options?: Options;
  /** Offer a button that fills the window with the preview. On by default. */
  fullscreen?: boolean;
  /** Show the file's size under its name. Off by default. */
  displaySize?: boolean;
  /**
   * Let views show how long their work took — a PDF's thumbnails, outline and
   * search. Off by default: it is a number for whoever is tuning papyra, not for a
   * reader.
   */
  displayRenderTime?: boolean;
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
 * Remote files download when shown, and the next one in the list is fetched while
 * the reader looks at the current one, so paging forward does not wait. Leaving a
 * file does not cancel its download — it finishes into the cache — but unmounting
 * the preview does.
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
  cache = defaultFileCache,
  options,
  fullscreen = true,
  displaySize = false,
  displayRenderTime = false,
  className,
}: FilePreviewProps<RendererId<R>, RendererOptions<R>> & {
  /** The formats this preview knows, in priority order. */
  renderers: R;
}) {
  const [own, setOwn] = useState(defaultIndex);
  const count = files.length;
  const at = Math.max(0, Math.min(index ?? own, count - 1));
  const source = files[at];
  const key = source === undefined ? '' : sourceKey(source);
  const signal = useUnmountSignal();
  const [full, toggleFullscreen] = useFullscreen();

  // A name or size only the response knew — a `Content-Disposition`, a length.
  const [learned, setLearned] = useState<{ key: string; info: SourceInfo }>();
  const info =
    learned?.key === key
      ? learned.info
      : source === undefined
        ? undefined
        : sourceInfo(source);
  const size = displaySize ? info?.size : undefined;

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

  const next = files[at + 1];
  const onReady = () => {
    if (next !== undefined) {
      void prefetch(next, renderers, allow, cache, signal());
    }
  };

  return (
    <section
      aria-label="File preview"
      className={cn(
        'flex min-h-0 min-w-0 flex-col',
        className,
        // `dvh`, not `vh`: on a phone the static viewport is taller than what shows
        // while the address bar is up. After `className`, so it wins over a height.
        full && 'fixed inset-0 z-50 h-dvh w-screen bg-background',
      )}
      onKeyDown={onKeyDown}
    >
      {source !== undefined && info ? (
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
              <p className="truncate text-sm font-medium">{info.name}</p>
              {(count > 1 || size !== undefined) && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {count > 1 && `${at + 1} of ${count}`}
                  {count > 1 && size !== undefined && ' · '}
                  {size !== undefined && formatBytes(size)}
                </p>
              )}
            </div>
            <Button
              aria-label={`Download ${info.name}`}
              onClick={() => void downloadSource(source, { cache })}
              size="icon-sm"
              variant="ghost"
            >
              <DownloadIcon />
            </Button>
            {fullscreen && (
              <Button
                aria-label={full ? 'Exit full screen' : 'Full screen'}
                aria-pressed={full}
                onClick={toggleFullscreen}
                size="icon-sm"
                variant="ghost"
              >
                {full ? <MinimizeIcon /> : <MaximizeIcon />}
              </Button>
            )}
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
            cache={cache}
            key={key}
            onInfo={(i) => setLearned({ key, info: i })}
            onReady={onReady}
            options={options as Readonly<Record<string, object>> | undefined}
            displayRenderTime={displayRenderTime}
            renderers={renderers}
            signal={signal}
            source={source}
          />
        </>
      ) : (
        <Notice icon={<FilesIcon />} title="No files to preview" />
      )}
    </section>
  );
}

/**
 * A signal that aborts when the preview unmounts — and only then.
 *
 * Made lazily and remade once aborted, rather than created in an effect: a child's
 * effects run before its parent's, so the first file's download would start before
 * a parent effect had made the controller. Remaking it is also what survives React's
 * development double-mount, which aborts the first one on purpose.
 */
function useUnmountSignal(): () => AbortSignal {
  const control = useRef<AbortController | null>(null);
  useEffect(() => () => control.current?.abort(), []);
  return () => {
    if (!control.current || control.current.signal.aborted) {
      control.current = new AbortController();
    }
    return control.current.signal;
  };
}

/** Only worth a `Range` request when some renderer might stream the file. */
function probes(renderers: readonly FileRenderer[]): boolean {
  return renderers.some((r) => r.input === 'url');
}

/**
 * Fetch the next file into the cache while the current one is being read.
 *
 * Only what it would actually need: a file that will be refused, or that streams,
 * stops at the inspection.
 */
async function prefetch(
  source: FileSource,
  renderers: readonly FileRenderer[],
  allow: readonly string[] | undefined,
  cache: FileCache,
  signal: AbortSignal,
): Promise<void> {
  try {
    const inspected = await inspectSource(source, {
      cache,
      signal,
      probe: probes(renderers),
    });
    const found = detectHead(inspected, inspected.head, renderers, allow);
    if (found.status === 'ok' && found.renderer.input !== 'url') {
      await resolveFile(source, { cache, signal });
    }
  } catch {
    /* Showing it will try again, and say what went wrong. */
  }
}

type Body =
  | { status: 'inspecting' }
  | { status: 'unsupported' }
  | { status: 'blocked'; renderer: FileRenderer }
  | { status: 'loading'; renderer: FileRenderer }
  | { status: 'file'; renderer: FileInputRenderer; file: File }
  | { status: 'url'; renderer: UrlInputRenderer; url: string; info: SourceInfo }
  | { status: 'failed'; error: unknown };

function FileBody({
  source,
  renderers,
  allow,
  cache,
  signal,
  onInfo,
  onReady,
  options,
  displayRenderTime,
}: {
  source: FileSource;
  renderers: readonly FileRenderer[];
  allow: readonly string[] | undefined;
  cache: FileCache;
  signal: () => AbortSignal;
  onInfo: (info: SourceInfo) => void;
  onReady: () => void;
  options: Readonly<Record<string, object>> | undefined;
  displayRenderTime: boolean;
}) {
  const [body, setBody] = useState<Body>({ status: 'inspecting' });
  const [attempt, setAttempt] = useState(0);
  // Object URLs handed to a streaming view, its refreshes included.
  const releases = useRef<(() => void)[]>([]);

  useEffect(() => {
    let live = true;
    const options = { cache, signal: signal() };
    setBody({ status: 'inspecting' });

    (async () => {
      const inspected = await inspectSource(source, {
        ...options,
        probe: probes(renderers),
      });
      if (!live) return;
      onInfo({
        name: inspected.name,
        type: inspected.type,
        size: inspected.size,
      });
      const found = detectHead(inspected, inspected.head, renderers, allow);
      if (found.status !== 'ok') {
        setBody(found);
        return;
      }
      const { renderer } = found;
      setBody({ status: 'loading', renderer });

      if (renderer.input === 'url') {
        const { url, release } = await resolveUrl(source, options);
        releases.current.push(release);
        if (live) setBody({ status: 'url', renderer, url, info: inspected });
      } else {
        const file = await resolveFile(source, options);
        if (!live) return;
        onInfo({ name: file.name, type: file.type, size: file.size });
        setBody({ status: 'file', renderer, file });
      }
      if (live) onReady();
    })().catch((error: unknown) => {
      if (live) setBody({ status: 'failed', error });
    });

    return () => {
      live = false;
      for (const release of releases.current.splice(0)) release();
    };
    // `allow` by content: an inline array literal is a new array every render. The
    // source by key, for the same reason — the key is what identifies it.
  }, [renderers, allow?.join('\0'), cache, attempt]);

  // The renderer's own defaults, then this preview's entry for it.
  const settingsFor = (renderer: FileRenderer) => ({
    options: { ...renderer.defaults, ...options?.[renderer.id] },
    displayRenderTime,
  });

  const name = sourceInfo(source).name;
  const download = <DownloadButton cache={cache} source={source} />;

  switch (body.status) {
    case 'inspecting':
      return <Loading />;
    case 'loading':
      return (
        <Loading
          label={
            source instanceof Blob || cache.get(sourceKey(source))
              ? undefined
              : 'Downloading…'
          }
        />
      );
    case 'unsupported':
      return (
        <Notice
          action={download}
          description={name}
          icon={<FileQuestionIcon />}
          title="No preview for this file"
        />
      );
    case 'blocked':
      return (
        <Notice
          action={download}
          description={name}
          icon={<BanIcon />}
          title={`${body.renderer.label} files are not previewed here`}
        />
      );
    case 'failed':
      return (
        <FailedNotice
          download={download}
          error={body.error}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      );
    case 'file': {
      const View = fileViewOf(body.renderer);
      const settings = settingsFor(body.renderer);
      return (
        <ViewBoundary download={download}>
          <Suspense fallback={<Loading />}>
            <div className="flex min-h-0 flex-1 flex-col">
              <View file={body.file} {...settings} />
            </div>
          </Suspense>
        </ViewBoundary>
      );
    }
    case 'url': {
      const View = urlViewOf(body.renderer);
      const settings = settingsFor(body.renderer);
      const refresh = async () => {
        const fresh = await resolveUrl(source, { cache, fresh: true });
        releases.current.push(fresh.release);
        return fresh.url;
      };
      return (
        <ViewBoundary download={download}>
          <Suspense fallback={<Loading />}>
            <div className="flex min-h-0 flex-1 flex-col">
              <View
                name={body.info.name}
                refresh={refresh}
                type={body.info.type}
                url={body.url}
                {...settings}
              />
            </div>
          </Suspense>
        </ViewBoundary>
      );
    }
  }
}

/** A download that failed, said in terms of what the reader can do about it. */
function FailedNotice({
  error,
  download,
  onRetry,
}: {
  error: unknown;
  download: ReactNode;
  onRetry: () => void;
}) {
  const kind = error instanceof SourceError ? error.kind : undefined;
  const title =
    kind === 'network'
      ? 'This file could not be downloaded'
      : kind === 'denied'
        ? 'Access to this file was refused'
        : kind === 'http'
          ? 'The server could not provide this file'
          : 'This file could not be opened';
  return (
    <Notice
      action={
        <>
          <Button onClick={onRetry} variant="outline">
            <RotateCwIcon />
            Try again
          </Button>
          {kind === undefined && download}
        </>
      }
      description={error instanceof Error ? error.message : String(error)}
      icon={
        kind === 'network' ? (
          <CloudOffIcon />
        ) : kind === 'denied' ? (
          <ShieldXIcon />
        ) : (
          <FileWarningIcon />
        )
      }
      title={title}
    />
  );
}

/** A view as the preview calls it: options are checked where they are set. */
type AnyFileView = FileView<object>;
/** {@link AnyFileView}, for streaming views. */
type AnyUrlView = UrlView<object>;

const fileViews = new WeakMap<
  FileInputRenderer['load'],
  LazyExoticComponent<AnyFileView>
>();
const urlViews = new WeakMap<
  UrlInputRenderer['load'],
  LazyExoticComponent<AnyUrlView>
>();

/**
 * One lazy component per view, for the page's lifetime.
 *
 * `lazy` caches its promise on the component it returns, so making a new one per
 * render would mean a new import, and a new suspense, every time a file is shown.
 * Keyed by `load` rather than the renderer, because `with` makes a new renderer
 * around the same view.
 */
function fileViewOf(renderer: FileInputRenderer) {
  const load = renderer.load;
  let view = fileViews.get(load);
  if (!view) {
    view = lazy(() => load().then((c) => ({ default: c as AnyFileView })));
    fileViews.set(load, view);
  }
  return view;
}

/** {@link fileViewOf}, for streaming views. */
function urlViewOf(renderer: UrlInputRenderer) {
  const load = renderer.load;
  let view = urlViews.get(load);
  if (!view) {
    view = lazy(() => load().then((c) => ({ default: c as AnyUrlView })));
    urlViews.set(load, view);
  }
  return view;
}

/**
 * Turns a view that throws — a corrupt PDF, a chunk that failed to load — into a
 * card for that one file, so the pager still works and the next file still opens.
 */
class ViewBoundary extends Component<
  { download: ReactNode; children: ReactNode },
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
        action={this.props.download}
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
      {action && (
        <EmptyContent className="flex-row justify-center">
          {action}
        </EmptyContent>
      )}
    </Empty>
  );
}

function Loading({ label }: { label?: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </div>
  );
}

function DownloadButton({
  source,
  cache,
}: {
  source: FileSource;
  cache: FileCache;
}) {
  return (
    <Button
      onClick={() => void downloadSource(source, { cache })}
      variant="outline"
    >
      <DownloadIcon />
      Download
    </Button>
  );
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
