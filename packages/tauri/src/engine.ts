import {
  type Attachment,
  type Availability,
  type BackendRenderOptions,
  buildOutlineTree,
  buildStructTree,
  type Capabilities,
  type DocumentMetadata,
  fingerprint,
  type OpenOptions,
  type OutlineNode,
  type PageBitmap,
  type PageLink,
  type PageSize,
  type PageText,
  type PdfBackend,
  PdfEngine,
  type PdfSource,
  rethrowLoadError,
  type StructNode,
  toAttachment,
  toBytes,
  toPageLink,
  toPageText,
} from '@build-qube/papyra/core';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

// The plugin answers in the native bindings' shapes; papyra's normalisers say which.
type NativePageText = Parameters<typeof toPageText>[1];
type NativeOutlineEntry = Parameters<typeof buildOutlineTree>[0][number];
type NativePageLink = Parameters<typeof toPageLink>[0];
type NativeAttachment = Parameters<typeof toAttachment>[0];
type NativeStructEntry = Parameters<typeof buildStructTree>[0][number];
type NativeInfo = { [K in keyof DocumentMetadata]?: string | null };

/** How pages travel from the host. */
export type TauriPageFormat = 'png' | 'rgba';

/** Options for {@link TauriEngine}. */
export interface TauriEngineOptions {
  /**
   * How pages come back from the host. `'png'` (the default) costs an encode in Rust
   * and a decode in the WebView, off its main thread; `'rgba'` costs neither and is
   * four times the bytes over an in-process channel, painted with `putImageData`.
   * Which is faster depends on the device — measure on yours.
   */
  format?: TauriPageFormat;
}

/** The plugin's answer to `open`. */
interface Opened {
  id: number;
  sizes: [number, number][];
  info: NativeInfo;
  pdfVersion: string | null;
}

/** papyra's engine reads everything, and so does the host running it. */
const EVERYTHING: Capabilities = {
  text: true,
  outline: true,
  links: true,
  attachments: true,
  structure: true,
  pageLabels: true,
  annotationsToggle: true,
};

/** The plugin's commands, by the name Tauri routes them under. */
const command = (name: string) => `plugin:papyra|${name}`;

/**
 * PDFs parsed and rendered by papyra in the Tauri app's host process, through
 * `tauri-plugin-papyra`.
 *
 * For a Tauri app's WebView, which is never cross-origin isolated on Android or iOS
 * and so cannot run papyra's wasm. Here the work runs on the host's real cores with
 * no wasm at all, and the WebView only paints.
 *
 * The app registers the plugin (`.plugin(tauri_plugin_papyra::init())`) and allows
 * `papyra:default` in its capabilities. Everything papyra's own engine reads, this one
 * does: same parser, same text, same structure tree.
 *
 * Documents live in the host until closed, so close what you open — the viewer's
 * store and file preview do.
 */
export class TauriEngine extends PdfEngine<TauriBackend> {
  readonly id = 'tauri';
  readonly #format: TauriPageFormat;

  constructor(options: TauriEngineOptions = {}) {
    super();
    this.#format = options.format ?? 'png';
  }

  availability(): Availability {
    if ('__TAURI_INTERNALS__' in globalThis) return { ok: true };
    return {
      ok: false,
      title: 'Not running inside a Tauri app',
      reason:
        'This engine renders in the app’s host process, through ' +
        'tauri-plugin-papyra, and this page is not in a Tauri WebView.',
    };
  }

  protected async load(
    source: PdfSource,
    options: OpenOptions,
  ): Promise<TauriBackend> {
    const bytes = await toBytes(source);
    let opened: Opened;
    try {
      opened = await invoke<Opened>(command('open'), bytes, {
        headers:
          options.password === undefined
            ? {}
            : // Headers are ASCII; a password need not be.
              { 'x-papyra-password': encodeURIComponent(options.password) },
      });
    } catch (e) {
      rethrowLoadError(e);
    }
    return new TauriBackend(opened, fingerprint(bytes), this.#format);
  }
}

/**
 * One document held by the host, as a papyra backend.
 *
 * @internal Exported for tests.
 */
export class TauriBackend implements PdfBackend {
  readonly capabilities = EVERYTHING;
  // A fetch can be aborted, but the render in Rust runs on regardless; abandoning it
  // would only make a page scrolled back to render twice.
  readonly abortable = false;
  readonly concurrency = 4;
  readonly #id: number;
  readonly #sizes: readonly PageSize[];
  readonly #info: DocumentMetadata;
  readonly #version: string | null;
  readonly #pages: string;

  constructor(
    opened: Opened,
    readonly fingerprint: string,
    readonly format: TauriPageFormat,
  ) {
    this.#id = opened.id;
    this.#sizes = opened.sizes.map(([width, height]) => ({ width, height }));
    const i = opened.info;
    this.#info = {
      title: i.title ?? null,
      author: i.author ?? null,
      subject: i.subject ?? null,
      keywords: i.keywords ?? null,
      creator: i.creator ?? null,
      producer: i.producer ?? null,
      created: i.created ?? null,
      modified: i.modified ?? null,
    };
    this.#version = opened.pdfVersion ?? null;
    // `papyra://localhost/` on macOS, iOS and Linux, `http://papyra.localhost/` on
    // Android and Windows — Tauri knows which, so ask it rather than sniff.
    this.#pages = `${convertFileSrc('', 'papyra')}${this.#id}/`;
  }

  get pageCount(): number {
    return this.#sizes.length;
  }

  pageSize(index: number): PageSize {
    const size = this.#sizes[index];
    if (!size) throw new RangeError(`page ${index} is out of range`);
    return size;
  }

  async renderPage(
    index: number,
    options: BackendRenderOptions,
    signal?: AbortSignal,
  ): Promise<PageBitmap> {
    const query = `dpi=${options.dpi}&annots=${options.annotations === false ? 0 : 1}&format=${this.format}`;
    const res = await fetch(`${this.#pages}${index}?${query}`, { signal });
    if (!res.ok) throw new Error(await res.text());
    if (this.format === 'png') {
      // Decoded off the main thread.
      return createImageBitmap(await res.blob());
    }
    const width = Number(res.headers.get('x-width'));
    const height = Number(res.headers.get('x-height'));
    return {
      width,
      height,
      stride: width * 4,
      format: 'rgba8',
      data: new Uint8Array(await res.arrayBuffer()),
    };
  }

  metadata(): DocumentMetadata {
    return this.#info;
  }

  pdfVersion(): string | null {
    return this.#version;
  }

  #call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return invoke<T>(command(name), { id: this.#id, ...args });
  }

  async pageText(index: number): Promise<PageText> {
    const text = await this.#call<NativePageText>('page_text', { index });
    // JSON carries offsets as numbers; papyra's lines hold a Float32Array.
    return toPageText(index, {
      ...text,
      lines: text.lines.map((line) => ({
        ...line,
        offsets: Float32Array.from(line.offsets),
      })),
    });
  }

  async outline(): Promise<OutlineNode[]> {
    return buildOutlineTree(await this.#call<NativeOutlineEntry[]>('outline'));
  }

  async links(index: number): Promise<readonly PageLink[]> {
    const links = await this.#call<NativePageLink[]>('links', { index });
    return links
      .map(toPageLink)
      .filter((link): link is PageLink => link !== null);
  }

  pageLabels(): Promise<readonly string[]> {
    return this.#call<string[]>('page_labels');
  }

  async attachments(): Promise<readonly Attachment[]> {
    const files = await this.#call<NativeAttachment[]>('attachments');
    return files.map(toAttachment);
  }

  async attachmentData(index: number): Promise<Uint8Array> {
    return new Uint8Array(
      await this.#call<ArrayBuffer>('attachment_data', { index }),
    );
  }

  async structTree(): Promise<StructNode[]> {
    return buildStructTree(
      await this.#call<NativeStructEntry[]>('struct_tree'),
    );
  }

  close(): void {
    void this.#call('close');
  }
}
