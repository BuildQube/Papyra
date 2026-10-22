import {
  type Availability,
  type BackendRenderOptions,
  type PageBitmap,
  type PagedBackend,
  PagedEngine,
  type PageSize,
  type PdfSource,
  RENDER_ONLY,
  toBytes,
} from '@build-qube/papyra/core';
import type { OfficeDoc, OfficeKind } from '@build-qube/papyra/office';
import { invoke } from '@tauri-apps/api/core';
import type { TauriEngineOptions } from './engine.js';
import {
  closeDocument,
  command,
  fetchPage,
  pagesOf,
  type TauriPageFormat,
  tauriAvailability,
} from './host.js';

/** The office plugin's answer to `open`. */
interface Opened {
  id: number;
  kind: OfficeKind;
  sizes: [number, number][];
}

/** One office document held by the host, as a papyra backend. */
class TauriOfficeBackend implements PagedBackend {
  readonly capabilities = RENDER_ONLY;
  // As TauriEngine: the render in Rust runs on whatever the fetch does.
  readonly abortable = false;
  readonly concurrency = 4;
  readonly kind: OfficeKind;
  readonly #id: number;
  readonly #sizes: readonly PageSize[];
  readonly #pages: string;
  readonly #format: TauriPageFormat;

  constructor(opened: Opened, format: TauriPageFormat) {
    this.#id = opened.id;
    this.kind = opened.kind;
    this.#sizes = opened.sizes.map(([width, height]) => ({ width, height }));
    this.#pages = pagesOf(opened.id);
    this.#format = format;
  }

  get pageCount(): number {
    return this.#sizes.length;
  }

  pageSize(index: number): PageSize {
    const size = this.#sizes[index];
    if (!size) throw new RangeError(`page ${index} is out of range`);
    return size;
  }

  /** `annotations` does not apply: an office page has none to switch off. */
  renderPage(
    index: number,
    { dpi }: BackendRenderOptions,
    signal?: AbortSignal,
  ): Promise<PageBitmap> {
    return fetchPage(`${this.#pages}${index}?dpi=${dpi}`, this.#format, signal);
  }

  close(): Promise<void> {
    return closeDocument(this.#id);
  }
}

/**
 * papyra's office engine — Word and PowerPoint, over WordCraft and DeckCraft — run
 * in the Tauri app's host process through `tauri-plugin-papyra-office`, beside
 * `tauri-plugin-papyra`. Allow `papyra:default` and `papyra-office:default`.
 *
 * Pass it where papyra's own `officeEngine` would go:
 * `pptxRenderer.with({ engine })` and `docxPagedRenderer.with({ engine })`. Pages
 * come over the `papyra://` protocol as a PDF's do, in the same `format`.
 *
 * The office crate is not on crates.io, because WordCraft and DeckCraft are not:
 * an app takes it and `tauri-plugin-papyra` from the GitHub repository at one tag.
 */
export class TauriOfficeEngine extends PagedEngine<
  OfficeDoc,
  TauriOfficeBackend
> {
  readonly id = 'tauri-office';
  readonly #format: TauriPageFormat;

  constructor(options: TauriEngineOptions = {}) {
    super();
    this.#format = options.format ?? 'png';
  }

  /**
   * Make a TrueType or OpenType font available to the host's Word and PowerPoint
   * layout, for every document opened after this call. Resolves to how many faces
   * were added. See papyra's `PapyraOfficeEngine.addFont` for why it matters.
   */
  async addFont(source: PdfSource): Promise<number> {
    return invoke<number>(
      command('add_font', 'papyra-office'),
      await toBytes(source),
    );
  }

  availability(): Availability {
    return tauriAvailability('tauri-plugin-papyra-office');
  }

  /** @internal */
  protected async load(source: PdfSource): Promise<TauriOfficeBackend> {
    const opened = await invoke<Opened>(
      command('open', 'papyra-office'),
      await toBytes(source),
    );
    return new TauriOfficeBackend(opened, this.#format);
  }

  /** @internal */
  protected handle(backend: TauriOfficeBackend): OfficeDoc {
    return {
      engine: this.id,
      kind: backend.kind,
      pageCount: backend.pageCount,
      pageSize: (index) => backend.pageSize(index),
      capabilities: backend.capabilities,
    };
  }
}
