import { HEAD_BYTES } from '@/lib/file-preview-core';

/**
 * What a resolver may hand back: somewhere to fetch from, or the content itself.
 *
 * A `Blob` or a `Response` covers what a URL cannot — an SDK that downloads for you,
 * a fetch that needs an `Authorization` header.
 */
export type ResolvedSource = string | URL | Blob | Response;

/** A file that lives elsewhere, fetched on demand. */
export interface RemoteFile {
  /**
   * Identifies the file to the cache, across renders and remounts.
   *
   * Required because a resolver is usually written inline, which makes it a new
   * function every render — and a file the cache cannot recognise is downloaded
   * again each time it is shown.
   */
  key: string;
  /** The file name to show, and to match extensions against. */
  name?: string;
  /** Its MIME type, if known before downloading. */
  type?: string;
  /** Its size in bytes, if known before downloading. */
  size?: number;
  /**
   * Where it is: a URL, or a function that produces one when asked.
   *
   * A function is for links that expire, such as signed URLs. It is called only
   * when the file is actually needed, and again once if the server answers 401 or
   * 403, which is what an expired signature looks like.
   */
  url: string | URL | (() => Promise<ResolvedSource>);
}

/**
 * Anything the preview can show: a `File` or `Blob` in hand, a URL, or a
 * {@link RemoteFile} with a resolver.
 */
export type FileSource = Blob | string | URL | RemoteFile;

/** What is known about a source without downloading all of it. */
export interface SourceInfo {
  /** The file name, from the source, the response, or the URL's path. */
  name: string;
  /** The MIME type, or `''` when nothing says. */
  type: string;
  /** The size in bytes, when anything has said. */
  size?: number;
}

/** Why a source could not be fetched. */
export type SourceErrorKind = 'network' | 'denied' | 'http';

/** A download that failed, with enough detail to tell the reader what to do. */
export class SourceError extends Error {
  /** Always `'SourceError'`. */
  override readonly name = 'SourceError';

  /**
   * @param kind `network` when the request never got an answer — offline, or a
   *   cross-origin server that does not allow CORS, which a browser reports
   *   identically. `denied` for 401 and 403, after a resolver had its retry.
   *   `http` for any other failing status.
   * @param message What went wrong.
   * @param status The HTTP status, when there was one.
   */
  constructor(
    readonly kind: SourceErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Options for {@link FileCache}. */
export interface FileCacheOptions {
  /** The most bytes of file content kept. Defaults to 256 MiB. */
  maxBytes?: number;
}

/** Heads are 512 bytes each; this many is a quarter of a megabyte. */
const MAX_HEADS = 500;

interface Pending {
  promise: Promise<File>;
  controller: AbortController;
  users: number;
}

/**
 * Downloaded files, least recently used first out, bounded by total bytes.
 *
 * One download per key however many previews ask for it: a second request for a file
 * still in flight joins the first. A download is cancelled only when every caller
 * waiting on it has given up, so one preview unmounting does not cut off another
 * showing the same file.
 *
 * There is one shared by default ({@link defaultFileCache}), so a file opened in a
 * dialog is already there when the same file opens on its own page. Pass your own to
 * a preview to size or clear it separately.
 */
export class FileCache {
  /** The byte budget, as given. */
  readonly maxBytes: number;
  readonly #files = new Map<string, File>();
  readonly #heads = new Map<string, Inspected>();
  readonly #pending = new Map<string, Pending>();
  readonly #minted = new Map<string, string>();
  #bytes = 0;

  constructor({ maxBytes = 256 * 1024 * 1024 }: FileCacheOptions = {}) {
    this.maxBytes = maxBytes;
  }

  /** Bytes of file content currently held. */
  get bytes(): number {
    return this.#bytes;
  }

  /** The file for a key, if held. Counts as a use. */
  get(key: string): File | undefined {
    const file = this.#files.get(key);
    if (file) {
      this.#files.delete(key);
      this.#files.set(key, file);
    }
    return file;
  }

  /**
   * Hold a file, evicting the least recently used until it fits. A file larger than
   * the whole budget is not held at all — it would only evict everything else and
   * then itself.
   */
  set(key: string, file: File): void {
    this.delete(key);
    if (file.size > this.maxBytes) return;
    this.#files.set(key, file);
    this.#bytes += file.size;
    for (const [oldest, old] of this.#files) {
      if (this.#bytes <= this.maxBytes) break;
      this.#files.delete(oldest);
      this.#bytes -= old.size;
    }
  }

  /** Forget a key's file and what was learned about it. */
  delete(key: string): void {
    const file = this.#files.get(key);
    if (file) this.#bytes -= file.size;
    this.#files.delete(key);
    this.#heads.delete(key);
    this.#minted.delete(key);
  }

  /** Forget everything. Downloads in flight finish, but are not kept. */
  clear(): void {
    this.#files.clear();
    this.#heads.clear();
    this.#minted.clear();
    this.#bytes = 0;
  }

  /**
   * The file for a key: held, already downloading, or fetched now.
   *
   * @param key The cache key.
   * @param fetcher Downloads the file. Its signal aborts once every caller has
   *   aborted theirs.
   * @param signal This caller giving up.
   */
  load(
    key: string,
    fetcher: (signal: AbortSignal) => Promise<File>,
    signal?: AbortSignal,
  ): Promise<File> {
    const held = this.get(key);
    if (held) return Promise.resolve(held);

    let pending = this.#pending.get(key);
    // An aborted job is still in the map until its rejection settles; joining it
    // would hand a fresh caller someone else's cancellation.
    if (!pending || pending.controller.signal.aborted) {
      const controller = new AbortController();
      const entry: Pending = {
        controller,
        users: 0,
        promise: fetcher(controller.signal)
          .then((file) => {
            this.set(key, file);
            return file;
          })
          .finally(() => {
            if (this.#pending.get(key) === entry) this.#pending.delete(key);
          }),
      };
      pending = entry;
      this.#pending.set(key, pending);
    }

    const job = pending;
    job.users++;
    if (signal) {
      const leave = () => {
        if (--job.users === 0) job.controller.abort(signal.reason);
      };
      if (signal.aborted) leave();
      else signal.addEventListener('abort', leave, { once: true });
    }
    return job.promise;
  }

  /** @internal What {@link inspectSource} learned, so it asks once per key. */
  inspected(key: string): Inspected | undefined {
    return this.#heads.get(key);
  }

  /** @internal The URL a resolver last answered with, for the next request. */
  minted(key: string): string | undefined {
    return this.#minted.get(key);
  }

  /** @internal */
  mint(key: string, url: string): void {
    this.#minted.delete(key);
    this.#minted.set(key, url);
    if (this.#minted.size > MAX_HEADS) {
      const oldest = this.#minted.keys().next().value;
      if (oldest !== undefined) this.#minted.delete(oldest);
    }
  }

  /** @internal */
  remember(key: string, inspected: Inspected): void {
    this.#heads.delete(key);
    this.#heads.set(key, inspected);
    if (this.#heads.size > MAX_HEADS) {
      const oldest = this.#heads.keys().next().value;
      if (oldest !== undefined) this.#heads.delete(oldest);
    }
  }
}

/** The cache every preview uses unless given its own. */
export const defaultFileCache = new FileCache();

const blobKeys = new WeakMap<Blob, string>();
let nextBlobKey = 0;

function isRemote(source: FileSource): source is RemoteFile {
  return (
    typeof source === 'object' &&
    !(source instanceof Blob) &&
    !(source instanceof URL)
  );
}

function absolute(url: string | URL): string {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return String(url);
  }
}

/**
 * The cache key for a source: the `key` a {@link RemoteFile} carries, the absolute
 * URL for a URL, and an identity for a `Blob` — so the same `File` object twice is
 * the same file, and two equal ones are two.
 */
export function sourceKey(source: FileSource): string {
  if (source instanceof Blob) {
    let key = blobKeys.get(source);
    if (key === undefined) {
      key = `blob:${nextBlobKey++}`;
      blobKeys.set(source, key);
    }
    return key;
  }
  if (isRemote(source)) return source.key;
  return absolute(source);
}

/** The last path segment of a URL, decoded — `report%20q3.pdf` is `report q3.pdf`. */
function nameFromUrl(url: string | URL): string {
  try {
    const parsed = new URL(
      url,
      globalThis.location?.href ?? 'http://localhost',
    );
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : parsed.hostname || 'download';
  } catch {
    return 'download';
  }
}

/** What is known about a source before any of it is fetched. */
export function sourceInfo(source: FileSource): SourceInfo {
  if (source instanceof Blob) {
    return {
      name: source instanceof File ? source.name : 'file',
      type: source.type,
      size: source.size,
    };
  }
  if (isRemote(source)) {
    return {
      name:
        source.name ??
        (typeof source.url === 'function'
          ? source.key
          : nameFromUrl(source.url)),
      type: source.type ?? '',
      size: source.size,
    };
  }
  return { name: nameFromUrl(source), type: '' };
}

/** `attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`, or the plain `filename=`. */
function nameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(header)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim());
    } catch {
      /* fall through to the plain form */
    }
  }
  return /filename\s*=\s*"?([^";]+)"?/i.exec(header)?.[1]?.trim();
}

/** Refine what the source said with what the response says. The source wins. */
function infoFrom(
  res: Response,
  known: SourceInfo,
  explicit: { name?: string; type?: string },
): SourceInfo {
  const range = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '')?.[1];
  const length = res.status === 200 ? res.headers.get('content-length') : null;
  const size = Number(range ?? length ?? Number.NaN);
  return {
    name:
      explicit.name ??
      nameFromDisposition(res.headers.get('content-disposition')) ??
      known.name,
    type:
      explicit.type ??
      res.headers.get('content-type')?.split(';')[0]?.trim() ??
      known.type,
    size: Number.isFinite(size) ? size : known.size,
  };
}

async function request(
  url: string | URL,
  signal: AbortSignal | undefined,
  headers?: HeadersInit,
): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new SourceError(
      'network',
      `Could not reach ${nameFromUrl(url)}. If it is on another origin, its server must send CORS headers.`,
    );
  }
  return checked(res);
}

/** The response, or the {@link SourceError} its status means. */
function checked(res: Response): Response {
  if (res.ok) return res;
  if (res.status === 401 || res.status === 403) {
    throw new SourceError(
      'denied',
      `Access was refused (${res.status}). If this is a signed link, it may have expired.`,
      res.status,
    );
  }
  throw new SourceError(
    'http',
    `The server answered ${res.status}.`,
    res.status,
  );
}

/**
 * Run `use` against what a source resolves to, giving a resolver one more call if
 * the answer is refused — a signed URL that expired between being minted and being
 * fetched.
 *
 * A URL a resolver already gave for this key is tried first, so inspecting a file
 * and then downloading it costs one signature, not two. Reusing it is safe for the
 * same reason the retry exists: if it has expired, the refusal mints a fresh one.
 */
async function withTarget<T>(
  source: string | URL | RemoteFile,
  cache: FileCache,
  use: (target: ResolvedSource) => Promise<T>,
): Promise<T> {
  if (!isRemote(source)) return use(source);
  const resolve = source.url;
  if (typeof resolve !== 'function') return use(resolve);
  const fresh = async () => {
    const target = await resolve();
    if (typeof target === 'string' || target instanceof URL) {
      cache.mint(source.key, String(target));
    }
    return target;
  };
  const reused = cache.minted(source.key);
  try {
    return await use(reused ?? (await fresh()));
  } catch (error) {
    if (!(error instanceof SourceError) || error.kind !== 'denied') throw error;
    return use(await fresh());
  }
}

function toFile(
  blob: Blob,
  info: SourceInfo,
  explicit: { name?: string; type?: string } = {},
): File {
  if (blob instanceof File && !explicit.name && !explicit.type) return blob;
  const own = blob instanceof File ? blob.name : undefined;
  return new File([blob], explicit.name ?? own ?? info.name, {
    type: explicit.type ?? (blob.type || info.type),
  });
}

async function responseToFile(
  res: Response,
  info: SourceInfo,
  explicit: { name?: string; type?: string },
): Promise<File> {
  const refined = infoFrom(checked(res), info, explicit);
  return toFile(await res.blob(), refined, explicit);
}

function explicitOf(source: FileSource): { name?: string; type?: string } {
  return isRemote(source) ? { name: source.name, type: source.type } : {};
}

/** Options for {@link resolveFile}, {@link inspectSource} and {@link resolveUrl}. */
export interface SourceOptions {
  /** Where downloaded files are kept. Defaults to {@link defaultFileCache}. */
  cache?: FileCache;
  /** This caller giving up. A shared download continues while others wait on it. */
  signal?: AbortSignal;
}

/**
 * The whole file, from the cache when it is there, downloaded once when it is not.
 */
export function resolveFile(
  source: FileSource,
  { cache = defaultFileCache, signal }: SourceOptions = {},
): Promise<File> {
  const info = sourceInfo(source);
  if (source instanceof Blob) return Promise.resolve(toFile(source, info));
  const explicit = explicitOf(source);
  return cache.load(
    sourceKey(source),
    (abort) =>
      withTarget(source, cache, async (target) => {
        if (target instanceof Blob) return toFile(target, info, explicit);
        if (target instanceof Response) {
          return responseToFile(target, info, explicit);
        }
        return responseToFile(await request(target, abort), info, explicit);
      }),
    signal,
  );
}

/** A source's first {@link HEAD_BYTES} bytes, and what is known about it. */
export interface Inspected extends SourceInfo {
  /** The first bytes, for sniffing. Shorter when the file is. */
  head: Uint8Array;
}

/** Read at most `n` bytes of a body, then stop the download. */
async function readPrefix(res: Response, n: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(await res.arrayBuffer()).slice(0, n);
  const out = new Uint8Array(n);
  let filled = 0;
  try {
    while (filled < n) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, n - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    // A server that ignored the Range header is mid-way through sending all of it.
    void reader.cancel().catch(() => undefined);
  }
  return out.slice(0, filled);
}

/** Options for {@link inspectSource}. */
export interface InspectOptions extends SourceOptions {
  /**
   * Read only the head, with a `Range` request, rather than downloading the file.
   *
   * Worth it only when the file might go to a renderer that streams — a video
   * should not be downloaded whole to find out it is a video. When every renderer
   * wants the whole file anyway, the download is the inspection, and one request
   * beats two.
   */
  probe?: boolean;
}

/**
 * What a source is: its first bytes for sniffing, its name, type and size.
 *
 * Asked once per key; the answer is kept in the cache alongside the files.
 */
export async function inspectSource(
  source: FileSource,
  { cache = defaultFileCache, signal, probe = false }: InspectOptions = {},
): Promise<Inspected> {
  if (source instanceof Blob) {
    const head = new Uint8Array(
      await source.slice(0, HEAD_BYTES).arrayBuffer(),
    );
    return { ...sourceInfo(source), head };
  }
  const key = sourceKey(source);
  const known = cache.inspected(key);
  if (known) return known;

  const held = cache.get(key);
  let inspected: Inspected;
  if (held || !probe) {
    const file = held ?? (await resolveFile(source, { cache, signal }));
    const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    inspected = { name: file.name, type: file.type, size: file.size, head };
  } else {
    const info = sourceInfo(source);
    const explicit = explicitOf(source);
    inspected = await withTarget(source, cache, async (target) => {
      // A resolver that handed over the content has already done the download.
      if (target instanceof Blob || target instanceof Response) {
        const file =
          target instanceof Blob
            ? toFile(target, info, explicit)
            : await responseToFile(target, info, explicit);
        cache.set(key, file);
        const head = new Uint8Array(
          await file.slice(0, HEAD_BYTES).arrayBuffer(),
        );
        return { name: file.name, type: file.type, size: file.size, head };
      }
      const res = await request(target, signal, {
        Range: `bytes=0-${HEAD_BYTES - 1}`,
      });
      return {
        ...infoFrom(res, info, explicit),
        head: await readPrefix(res, HEAD_BYTES),
      };
    });
  }
  cache.remember(key, inspected);
  return inspected;
}

/** A URL a view can point an element at, and how to let go of it. */
export interface SourceUrl {
  /** Fetchable by the browser: the source's own URL, or an object URL. */
  url: string;
  /** Revokes the object URL, if one was made. Call it when the view is done. */
  release: () => void;
}

/**
 * A URL for a view that streams rather than downloading — a `<video src>`.
 *
 * A held `File` becomes an object URL. A URL is used as it is. A resolver is
 * called, unless `fresh` is false and the file is already held, and its answer used.
 *
 * @param source The source.
 * @param options Cache and signal; `fresh` asks a resolver again even when it has
 *   already answered, for a stream whose signed link expired mid-playback.
 */
export async function resolveUrl(
  source: FileSource,
  {
    cache = defaultFileCache,
    fresh = false,
  }: SourceOptions & { fresh?: boolean } = {},
): Promise<SourceUrl> {
  const local = (blob: Blob): SourceUrl => {
    const url = URL.createObjectURL(blob);
    return { url, release: () => URL.revokeObjectURL(url) };
  };
  if (source instanceof Blob) return local(source);
  const held = fresh ? undefined : cache.get(sourceKey(source));
  if (held) return local(held);
  if (!isRemote(source)) return { url: absolute(source), release: () => {} };
  let target: ResolvedSource;
  if (typeof source.url !== 'function') target = source.url;
  else {
    const reused = fresh ? undefined : cache.minted(source.key);
    target = reused ?? (await source.url());
    if (typeof target === 'string' || target instanceof URL) {
      cache.mint(source.key, String(target));
    }
  }
  if (target instanceof Blob) return local(target);
  if (target instanceof Response) {
    const file = await responseToFile(
      target,
      sourceInfo(source),
      explicitOf(source),
    );
    cache.set(source.key, file);
    return local(file);
  }
  return { url: absolute(target), release: () => {} };
}

/**
 * Save a source to the reader's disk: the held copy when there is one, a fresh
 * resolve when there is not — so a download button never hands over an expired link.
 */
export async function downloadSource(
  source: FileSource,
  { cache = defaultFileCache }: Pick<SourceOptions, 'cache'> = {},
): Promise<void> {
  const name = sourceInfo(source).name;
  const { url, release } = await resolveUrl(source, { cache });
  const a = document.createElement('a');
  a.href = url;
  a.download = cache.get(sourceKey(source))?.name ?? name;
  // A cross-origin link ignores `download` and navigates instead; a new tab keeps
  // the preview where it was.
  a.target = '_blank';
  a.rel = 'noopener';
  a.click();
  // Revoked on the next task, not now: the click starts the download asynchronously
  // and a URL revoked under it fails in Firefox.
  setTimeout(release);
}
