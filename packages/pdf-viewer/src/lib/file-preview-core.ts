import type { ComponentType } from 'react';

/** Props a view that takes the whole file receives. */
export interface FileViewProps {
  /** The file to show, downloaded and held in the cache. */
  file: File;
}

/** Props a view that streams from a URL receives. */
export interface UrlViewProps {
  /**
   * Something the browser can fetch: the source's own URL, a freshly resolved
   * signed one, or an object URL for a file already in hand.
   */
  url: string;
  /** The file name. */
  name: string;
  /** The MIME type, or `''` when nothing says. */
  type: string;
  /**
   * Resolve the URL again, for a stream whose signed link expired part-way — call it
   * when the element reports an error, and point it at the answer.
   */
  refresh: () => Promise<string>;
}

/**
 * What every renderer declares: how to recognise its format.
 *
 * A renderer is deliberately two halves. Everything here is a few strings and a byte
 * check, so holding one costs nothing; the view, and whatever it depends on — a PDF
 * engine, a syntax highlighter — arrives through `load` only when a file of this type
 * is actually shown. A descriptor must therefore never import its view statically,
 * or the split is gone.
 */
export interface RendererBase<Id extends string = string> {
  /** The name an `allow` list uses for this format. Unique within one preview. */
  readonly id: Id;
  /** What a person calls it — "PDF", "Image". Shown when a file is refused. */
  readonly label: string;
  /**
   * Extensions, lower-case, with the dot. For a renderer with no
   * {@link RendererBase.sniff} this is how a file is recognised; for every renderer
   * it is what {@link acceptOf} puts on a file input.
   */
  readonly extensions: readonly string[];
  /** MIME types, `image/*` style wildcards allowed. Used as `extensions` is. */
  readonly mimes: readonly string[];
  /**
   * Recognise the format from the file's first {@link HEAD_BYTES} bytes.
   *
   * When present it is **authoritative**: the name and MIME type are ignored, in
   * both directions. A PNG called `notes.txt` is an image, and an HTML page called
   * `photo.png` is not — which is what makes an `allow` list mean something, since
   * both of those are just a rename away.
   */
  readonly sniff?: (head: Uint8Array) => boolean;
  /**
   * The format is text. A file that matches by name but has a NUL byte in its head
   * is binary, and is not handed to this renderer.
   */
  readonly text?: boolean;
}

/** A renderer whose view needs the whole file: a PDF, an image, source code. */
export interface FileInputRenderer<Id extends string = string>
  extends RendererBase<Id> {
  /** Omitted or `'file'`: the file is downloaded, cached, then shown. */
  readonly input?: 'file';
  /** The view. Called once, the first time a file of this type is shown. */
  readonly load: () => Promise<ComponentType<FileViewProps>>;
}

/**
 * A renderer whose view streams from a URL: audio, video — anything an element can
 * play while it downloads, and that is too large to download first.
 */
export interface UrlInputRenderer<Id extends string = string>
  extends RendererBase<Id> {
  /** `'url'`: the view gets a URL, and the file is never downloaded whole. */
  readonly input: 'url';
  /** The view. Called once, the first time a file of this type is shown. */
  readonly load: () => Promise<ComponentType<UrlViewProps>>;
}

/** One file format: how to recognise it, and where its view is. */
export type FileRenderer<Id extends string = string> =
  | FileInputRenderer<Id>
  | UrlInputRenderer<Id>;

/**
 * Declare a renderer, keeping its `id` as a literal type.
 *
 * Without this the id widens to `string` and an `allow` list built from it accepts
 * anything — the identity function is here for the inference, not the runtime.
 */
export function defineRenderer<const Id extends string>(
  renderer: FileRenderer<Id>,
): FileRenderer<Id> {
  return renderer;
}

/** The union of ids in a renderer list: what an `allow` list may name. */
export type RendererId<R extends readonly FileRenderer[]> = R[number]['id'];

/**
 * How many leading bytes {@link RendererBase.sniff} sees.
 *
 * Every binary signature in use fits in 16; the rest is for SVG, whose `<svg` can sit
 * behind an XML prolog, a doctype and a licence comment.
 */
export const HEAD_BYTES = 512;

/** A file a renderer recognised, in a format the `allow` list permits. */
export interface Detected<Id extends string = string> {
  /** Always `'ok'`. */
  readonly status: 'ok';
  /** The renderer to show it with. */
  readonly renderer: FileRenderer<Id>;
}

/** A file a renderer recognised, in a format the `allow` list leaves out. */
export interface Blocked<Id extends string = string> {
  /** Always `'blocked'`. */
  readonly status: 'blocked';
  /** The renderer that recognised it, for its {@link FileRenderer.label}. */
  readonly renderer: FileRenderer<Id>;
}

/** A file no renderer given recognises. */
export interface Unsupported {
  /** Always `'unsupported'`. */
  readonly status: 'unsupported';
}

/** What {@link detect} found for one file. */
export type Detection<Id extends string = string> =
  | Detected<Id>
  | Blocked<Id>
  | Unsupported;

/** The lower-cased extension of a file name, with its dot, or `''`. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot).toLowerCase();
}

function mimeMatches(patterns: readonly string[], type: string): boolean {
  if (!type) return false;
  const t = type.toLowerCase().split(';')[0]?.trim() ?? '';
  return patterns.some((p) =>
    p.endsWith('/*') ? t.startsWith(p.slice(0, -1)) : p === t,
  );
}

/**
 * Pick the renderer for a file whose head has already been read.
 *
 * Sniffing renderers are tried first and in order, then the rest by MIME type or
 * extension, also in order — so list order is priority. Within that, the extension
 * beats an exact MIME type, which beats a wildcard such as `text/*`, wherever the
 * renderers sit in the list. The `allow` list plays no
 * part in *which* renderer matches, only in whether it may run: a file that sniffs
 * as an image is an image, and with images disallowed it is refused rather than
 * reinterpreted as whatever else would take it.
 */
export function detectHead<const R extends readonly FileRenderer[]>(
  file: Pick<File, 'name' | 'type'>,
  head: Uint8Array,
  renderers: R,
  allow?: readonly RendererId<R>[],
): Detection<RendererId<R>> {
  const found = match(file, head, renderers);
  if (!found) return { status: 'unsupported' };
  const renderer = found as FileRenderer<RendererId<R>>;
  if (allow && !allow.includes(renderer.id)) {
    return { status: 'blocked', renderer };
  }
  return { status: 'ok', renderer };
}

function match(
  file: Pick<File, 'name' | 'type'>,
  head: Uint8Array,
  renderers: readonly FileRenderer[],
): FileRenderer | undefined {
  for (const r of renderers) {
    if (r.sniff?.(head)) return r;
  }
  const ext = extensionOf(file.name);
  const binary = head.includes(0);
  const byName = renderers.filter((r) => !r.sniff && !(r.text && binary));
  // Most specific first. A wildcard is a fallback: `code` claims `text/*`, and
  // listing it before `csv` must not hand it every `text/csv` file. The extension
  // beats an exact MIME type because a browser derives a file's type from the
  // extension anyway, through an OS table that is often wrong — Windows with Excel
  // installed calls every `.csv` `application/vnd.ms-excel`.
  return (
    byName.find((r) => r.extensions.includes(ext)) ??
    byName.find((r) =>
      mimeMatches(
        r.mimes.filter((m) => !m.endsWith('/*')),
        file.type,
      ),
    ) ??
    byName.find((r) => mimeMatches(r.mimes, file.type))
  );
}

/** Read a file's head and pick its renderer. See {@link detectHead}. */
export async function detect<const R extends readonly FileRenderer[]>(
  file: File,
  renderers: R,
  allow?: readonly RendererId<R>[],
): Promise<Detection<RendererId<R>>> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  return detectHead(file, head, renderers, allow);
}

/**
 * The `accept` attribute for a file input that takes what these renderers show.
 *
 * Advisory only — a picker can be told "All files", and a drop zone has no such
 * attribute — which is why detection never trusts the name.
 */
export function acceptOf<const R extends readonly FileRenderer[]>(
  renderers: R,
  allow?: readonly RendererId<R>[],
): string {
  return renderers
    .filter((r) => !allow || allow.includes(r.id))
    .flatMap((r) => [...r.mimes, ...r.extensions])
    .join(',');
}

/** `head` begins with `bytes`, starting `offset` bytes in. */
export function startsWith(
  head: Uint8Array,
  bytes: readonly number[],
  offset = 0,
): boolean {
  return bytes.every((b, i) => head[offset + i] === b);
}

/** `head` holds `text` as ASCII, starting `offset` bytes in. */
export function startsWithAscii(
  head: Uint8Array,
  text: string,
  offset = 0,
): boolean {
  for (let i = 0; i < text.length; i++) {
    if (head[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * The major brand of an ISO base media file — MP4, MOV, M4A, AVIF and HEIC are all
 * this container, and the brand at bytes 8–11 is what tells them apart.
 */
export function isoBrand(head: Uint8Array): string | undefined {
  if (!startsWithAscii(head, 'ftyp', 4) || head.length < 12) return undefined;
  return String.fromCharCode(...head.subarray(8, 12));
}

/** `head` contains `text` as ASCII somewhere. */
export function includesAscii(head: Uint8Array, text: string): boolean {
  for (let i = 0; i <= head.length - text.length; i++) {
    if (startsWithAscii(head, text, i)) return true;
  }
  return false;
}
