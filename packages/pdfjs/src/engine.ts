import {
  type Attachment,
  type Availability,
  type BackendRenderOptions,
  type Capabilities,
  type DocumentMetadata,
  fingerprint,
  IncorrectPasswordError,
  type OpenOptions,
  type OutlineNode,
  type PageLink,
  type PageSize,
  type PageText,
  PasswordRequiredError,
  type PdfBackend,
  PdfEngine,
  type PdfSource,
  toBytes,
} from '@build-qube/papyra/core';
import type {
  DocumentInitParameters,
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist/types/src/display/api';
import { toDestination } from './dest.js';
import { linesFromItems, type PdfjsTextItem } from './text.js';

/** pdf.js itself, as `import('pdfjs-dist')` gives it. */
export type Pdfjs = typeof import('pdfjs-dist');

/** Options for {@link PdfjsEngine}. */
export interface PdfjsEngineOptions {
  /**
   * URL of pdf.js's worker script, `pdfjs-dist/build/pdf.worker.mjs`, as your
   * bundler serves it — in Vite, `new URL('pdfjs-dist/build/pdf.worker.mjs',
   * import.meta.url).toString()`. Leave it out if the app sets
   * `GlobalWorkerOptions.workerSrc` itself.
   */
  workerSrc?: string;
  /**
   * How to load pdf.js. `import('pdfjs-dist')` by default; pass another to use the
   * legacy build, or a copy the app has already loaded.
   */
  pdfjs?: () => Promise<Pdfjs>;
  /**
   * Passed to every `getDocument` — where pdf.js finds what it does not bundle:
   * `standardFontDataUrl` for the fourteen standard fonts, `cMapUrl` for CJK text,
   * `wasmUrl` for its JPEG 2000 and colour-profile decoders. pdf.js warns and falls
   * back without them.
   */
  document?: Omit<DocumentInitParameters, 'data' | 'url' | 'password'>;
}

/**
 * pdf.js draws on the main thread, between its worker's parsing, so two at once
 * keep a scroll responsive where papyra's four would not.
 */
const CONCURRENCY = 2;

/** No `/StructTreeRoot` reader: pdf.js has one, with no join from a line to its tag. */
const CAPABILITIES: Capabilities = {
  text: true,
  outline: true,
  links: true,
  attachments: true,
  structure: false,
  pageLabels: true,
  annotationsToggle: true,
};

/**
 * PDFs through [pdf.js](https://mozilla.github.io/pdf.js/), for pages papyra's own
 * engine cannot run on — a WebView that is never cross-origin isolated, or an
 * embedding page that cannot set the headers.
 *
 * Constructing one loads nothing; pdf.js is imported by the first `open`.
 *
 * What differs from papyra's engine:
 *
 * - Pages come back as `ImageBitmap`s, rendered into an `OffscreenCanvas`.
 * - Text geometry is approximate inside a pdf.js text item: it reports one width per
 *   item, which is spread evenly over the item's characters.
 * - No structure tree, and `undecodedGlyphs` is always 0 — pdf.js does not say which
 *   glyphs it could not map to Unicode.
 * - A render that nobody waits for any more is cancelled part-way.
 *
 * `fingerprint` is papyra's content hash, so a file keeps its key across engines.
 */
export class PdfjsEngine extends PdfEngine<PdfjsBackend> {
  readonly id = 'pdfjs';
  readonly #options: PdfjsEngineOptions;
  #lib: Promise<Pdfjs> | undefined;

  constructor(options: PdfjsEngineOptions = {}) {
    super();
    this.#options = options;
  }

  availability(): Availability {
    if (typeof OffscreenCanvas !== 'undefined') return { ok: true };
    return {
      ok: false,
      title: 'This runtime cannot render with pdf.js',
      reason:
        'pdf.js renders here into an OffscreenCanvas, which this runtime does ' +
        'not have. It needs a browser from 2023 or later.',
    };
  }

  #pdfjs(): Promise<Pdfjs> {
    this.#lib ??= (this.#options.pdfjs ?? (() => import('pdfjs-dist')))().then(
      (lib) => {
        const src = this.#options.workerSrc;
        if (src) lib.GlobalWorkerOptions.workerSrc = src;
        return lib;
      },
    );
    return this.#lib;
  }

  protected async load(
    source: PdfSource,
    options: OpenOptions,
  ): Promise<PdfjsBackend> {
    const [lib, bytes] = await Promise.all([this.#pdfjs(), toBytes(source)]);
    let pdf: PDFDocumentProxy;
    try {
      // A copy: pdf.js transfers what it is given to its worker, which would
      // detach the caller's buffer.
      pdf = await lib.getDocument({
        ...this.#options.document,
        data: bytes.slice(),
        password: options.password,
      }).promise;
    } catch (e) {
      if (e instanceof lib.PasswordException) {
        throw e.code === lib.PasswordResponses.INCORRECT_PASSWORD
          ? new IncorrectPasswordError()
          : new PasswordRequiredError();
      }
      throw e;
    }

    // Every page's size up front: a viewer lays out the whole column before it
    // renders anything, and `pageSize` is synchronous.
    const pages = await Promise.all(
      Array.from({ length: pdf.numPages }, (_, i) => pdf.getPage(i + 1)),
    );
    const sizes = pages.map((page) => {
      const { width, height } = page.getViewport({ scale: 1 });
      return { width, height };
    });
    const { info } = (await pdf.getMetadata()) as unknown as {
      info: Record<string, unknown>;
    };
    return new PdfjsBackend(
      lib,
      pdf,
      pages,
      sizes,
      fingerprint(bytes),
      toMetadata(lib, info),
      typeof info.PDFFormatVersion === 'string' ? info.PDFFormatVersion : null,
    );
  }
}

function toMetadata(
  lib: Pdfjs,
  info: Record<string, unknown>,
): DocumentMetadata {
  // Trimmed, as papyra trims: a title is a title, not a title and a newline.
  const text = (key: string) => {
    const value = info[key];
    return typeof value === 'string' && value.trim() !== ''
      ? value.trim()
      : null;
  };
  const date = (key: string) => {
    const value = text(key);
    return value === null
      ? null
      : (lib.PDFDateString.toDateObject(value)?.toISOString() ?? null);
  };
  return {
    title: text('Title'),
    author: text('Author'),
    subject: text('Subject'),
    keywords: text('Keywords'),
    creator: text('Creator'),
    producer: text('Producer'),
    created: date('CreationDate'),
    modified: date('ModDate'),
  };
}

/** A link annotation, as much of it as this reads. */
interface PdfjsLink {
  subtype: string;
  rect: number[];
  url?: string;
  unsafeUrl?: string;
  dest?: string | unknown[] | null;
  contentsObj?: { str?: string };
}

/** pdf.js's outline entry, as much of it as this reads. */
interface PdfjsOutlineItem {
  title: string;
  bold: boolean;
  italic: boolean;
  dest: string | unknown[] | null;
  count?: number;
  items: PdfjsOutlineItem[];
}

/**
 * One pdf.js document, as a papyra backend.
 *
 * @internal Exported for tests.
 */
export class PdfjsBackend implements PdfBackend {
  readonly capabilities = CAPABILITIES;
  readonly concurrency = CONCURRENCY;
  readonly abortable = true;
  #attachments: Promise<string[]> | undefined;

  constructor(
    readonly lib: Pdfjs,
    readonly pdf: PDFDocumentProxy,
    readonly pages: readonly PDFPageProxy[],
    readonly sizes: readonly PageSize[],
    readonly fingerprint: string,
    readonly info: DocumentMetadata,
    readonly version: string | null,
  ) {}

  get pageCount(): number {
    return this.pages.length;
  }

  pageSize(index: number): PageSize {
    const size = this.sizes[index];
    if (!size) throw new RangeError(`page ${index} is out of range`);
    return size;
  }

  #page(index: number): PDFPageProxy {
    const page = this.pages[index];
    if (!page) throw new RangeError(`page ${index} is out of range`);
    return page;
  }

  async renderPage(
    index: number,
    options: BackendRenderOptions,
    signal?: AbortSignal,
  ): Promise<ImageBitmap> {
    signal?.throwIfAborted();
    const page = this.#page(index);
    const viewport = page.getViewport({ scale: options.dpi / 72 });
    // Floored, as hayro floors its pixmap, so `viewport()` agrees with the bitmap.
    const canvas = new OffscreenCanvas(
      Math.floor(viewport.width),
      Math.floor(viewport.height),
    );
    const task = page.render({
      canvas: canvas as unknown as HTMLCanvasElement,
      viewport,
      annotationMode:
        options.annotations === false
          ? this.lib.AnnotationMode.DISABLE
          : this.lib.AnnotationMode.ENABLE,
    });
    const cancel = () => task.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await task.promise;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
    return canvas.transferToImageBitmap();
  }

  metadata(): DocumentMetadata {
    return this.info;
  }

  pdfVersion(): string | null {
    return this.version;
  }

  async pageText(index: number): Promise<PageText> {
    const page = this.#page(index);
    const content = await page.getTextContent();
    const items = content.items.filter(
      (item): item is PdfjsTextItem & (typeof content.items)[number] =>
        'str' in item,
    );
    return {
      page: index,
      lines: linesFromItems(
        items,
        content.styles,
        page.getViewport({ scale: 1 }).transform,
      ),
      undecodedGlyphs: 0,
    };
  }

  #dest(dest: string | unknown[] | null | undefined) {
    return (async () => {
      const explicit =
        typeof dest === 'string'
          ? await this.pdf.getDestination(dest)
          : (dest ?? null);
      return toDestination(explicit, (ref) =>
        this.pdf.getPageIndex(
          ref as Parameters<PDFDocumentProxy['getPageIndex']>[0],
        ),
      );
    })();
  }

  async outline(): Promise<OutlineNode[]> {
    const walk = (items: PdfjsOutlineItem[]): Promise<OutlineNode[]> =>
      Promise.all(
        items.map(async (item) => {
          const dest = await this.#dest(item.dest);
          return {
            title: item.title,
            dest,
            page: dest?.page ?? null,
            bold: item.bold,
            italic: item.italic,
            open: (item.count ?? 0) > 0,
            children: await walk(item.items),
          };
        }),
      );
    return walk(((await this.pdf.getOutline()) ?? []) as PdfjsOutlineItem[]);
  }

  async links(index: number): Promise<readonly PageLink[]> {
    const page = this.#page(index);
    const viewport = page.getViewport({ scale: 1 });
    const annotations = (await page.getAnnotations()) as PdfjsLink[];
    const links: PageLink[] = [];
    for (const a of annotations) {
      if (a.subtype !== 'Link') continue;
      const [r0 = 0, r1 = 0, r2 = 0, r3 = 0] = a.rect;
      const [x0 = 0, y0 = 0] = viewport.convertToViewportPoint(r0, r1);
      const [x1 = 0, y1 = 0] = viewport.convertToViewportPoint(r2, r3);
      const rect = {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        width: Math.abs(x1 - x0),
        height: Math.abs(y1 - y0),
      };
      const alt = a.contentsObj?.str || null;
      // `url` is set only when pdf.js judged the target safe, so a `javascript:`
      // one never arrives; the string reported is the file's own, as papyra's is,
      // rather than pdf.js's normalisation of it.
      if (a.url) {
        const uri = a.unsafeUrl ?? a.url;
        links.push({ rect, target: { kind: 'uri', uri }, alt });
        continue;
      }
      const dest = await this.#dest(a.dest);
      if (dest) links.push({ rect, target: { kind: 'internal', dest }, alt });
    }
    return links;
  }

  async pageLabels(): Promise<readonly string[]> {
    return (await this.pdf.getPageLabels()) ?? [];
  }

  /** Attachment ids, in the order `attachments` lists them. */
  #ids(): Promise<string[]> {
    this.#attachments ??= this.pdf
      .getAttachments()
      .then((map) => (map ? [...map.keys()] : []));
    return this.#attachments;
  }

  async attachments(): Promise<readonly Attachment[]> {
    const map = await this.pdf.getAttachments();
    if (!map) return [];
    return [...map.values()].map((file, index) => ({
      index,
      name: file.filename,
      description: file.description || null,
      mediaType: null,
      size: file.content?.byteLength ?? null,
      created: null,
      modified: null,
      relationship: null,
    }));
  }

  async attachmentData(index: number): Promise<Uint8Array> {
    const id = (await this.#ids())[index];
    if (id === undefined) throw new RangeError(`no attachment ${index}`);
    const data = await this.pdf.getAttachmentContent(id);
    if (!data) throw new Error(`attachment ${index} has no contents`);
    return data;
  }

  close(): void {
    void this.pdf.loadingTask.destroy();
  }
}
