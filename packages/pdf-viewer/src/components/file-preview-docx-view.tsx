import {
  type HElement,
  type Options,
  parseAsync,
  renderDocument,
} from 'docx-preview';
import JSZip from 'jszip';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import type { FileViewProps } from '@/lib/file-preview-core';

/**
 * Past this, a file is refused rather than parsed. `docx-preview` inflates every part
 * it needs into memory, as strings, on the main thread; a Word document this large is
 * almost always one carrying video or scans, which a preview would not show anyway.
 */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * The main part's content type, for a document, a template, and their macro-enabled
 * twins. A `.docx` is recognised by name only, so this is where a renamed workbook,
 * deck or plain zip is told apart from a Word document.
 */
const WORD_MAIN =
  /wordprocessingml\.(document|template)\.main\+xml|ms-word\.(document|template)\.macroenabled(template)?\.main\+xml/i;

/** The package declares a Word main part. Takes `[Content_Types].xml`'s text. */
export function isWordPackage(contentTypes: string): boolean {
  return WORD_MAIN.test(contentTypes);
}

/** The OLE compound file signature. */
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/** Schemes a link may keep. Everything else, `javascript:` included, loses its target. */
const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);

/** A hyperlink target that survived {@link linkPolicy}. */
export interface SafeLink {
  /** The target, normalised. */
  href: string;
  /** Opens in a new tab; otherwise a bookmark in the same document. */
  external: boolean;
}

/**
 * What a hyperlink in the document may point at: a bookmark in the same document, or
 * an absolute URL with a scheme that cannot run anything. A relative target has no
 * meaning outside the author's machine, so it is dropped too.
 */
export function linkPolicy(href: string | null): SafeLink | undefined {
  if (!href) return undefined;
  if (href.startsWith('#'))
    return href.length > 1 ? { href, external: false } : undefined;
  try {
    const url = new URL(href);
    if (LINK_PROTOCOLS.has(url.protocol))
      return { href: url.href, external: true };
  } catch {
    /* Not absolute. */
  }
  return undefined;
}

/**
 * Elements `docx-preview` could be steered into making that either run something or
 * fetch something. `iframe` is the real one: an `altChunk` part is arbitrary HTML,
 * which the library puts into an `<iframe srcdoc>` — same-origin, scripts and all —
 * unless told not to. `renderAltChunks: false` already stops that; this is the second
 * lock, for whatever a later version adds.
 */
const DROPPED = new Set([
  'base',
  'embed',
  'form',
  'frame',
  'iframe',
  'link',
  'meta',
  'object',
  'script',
]);

const SERIF =
  /^(cambria|georgia|times|garamond|book antiqua|palatino|constantia|baskerville|century|bookman|caladea)/i;
const MONO =
  /^(consolas|courier|menlo|monaco|lucida console|cascadia|dejavu sans mono)/i;
const GENERIC =
  /(^|,)\s*(serif|sans-serif|monospace|cursive|fantasy|system-ui)\s*$/i;

/**
 * A `font-family` value with a generic family appended. Documents name `Calibri` or
 * `Aptos`, which almost nothing outside Windows and Office has, and an unknown family
 * with no fallback lands on the browser's default — a serif, which turns a modern
 * document into a typewritten one. The generic is chosen from the first family's
 * name, so a Cambria document stays serif and Consolas stays monospaced.
 */
export function withGenericFont(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || GENERIC.test(trimmed)) return value;
  const first = trimmed.replace(/^["']/, '');
  const generic = MONO.test(first)
    ? 'monospace'
    : SERIF.test(first)
      ? 'serif'
      : 'sans-serif';
  return `${trimmed}, ${generic}`;
}

/** {@link withGenericFont} over every stylesheet and inline style the library wrote. */
function addGenericFonts(doc: Document): void {
  for (const style of doc.head.querySelectorAll('style[data-docx]')) {
    style.textContent = (style.textContent ?? '').replace(
      // Quoted names whole: a family name can hold `;` or `}`.
      /font-family:\s*((?:'[^']*'|"[^"]*"|[^;}'"])+)/g,
      (_, value: string) => `font-family: ${withGenericFont(value)}`,
    );
  }
  for (const el of doc.body.querySelectorAll<HTMLElement>(
    '[style*="font-family"]',
  )) {
    el.style.fontFamily = withGenericFont(el.style.fontFamily);
  }
}

/**
 * The frame the document is drawn in. Sandboxed without `allow-scripts`, so nothing in
 * it can run, and under a CSP that permits no network at all: images and embedded
 * fonts arrive as `data:` URLs, and a stylesheet the document managed to inject cannot
 * load a tracking pixel or an `@import`. The styles themselves only reach the frame.
 */
const SHELL = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<style>
html, body { margin: 0; }
html body .docx-wrapper { background: transparent; padding: 16px 16px 0; }
html body .docx-wrapper > section.docx { box-shadow: 0 1px 3px rgb(0 0 0 / 0.3); margin-bottom: 16px; }
html body a[href] { cursor: pointer; }
</style></head><body></body></html>`;

const OPTIONS: Partial<Options> = {
  // `data:` rather than object URLs: the library never revokes the ones it makes,
  // and a `data:` URL goes when the frame does.
  useBase64URL: true,
  renderAltChunks: false,
  renderComments: false,
  renderChanges: false,
};

/** A node from any realm — the frame's `Node` is not the page's. */
const isNode = (v: unknown): v is Node =>
  typeof v === 'object' && v !== null && 'nodeType' in v;

/**
 * `docx-preview`'s element factory, but making elements in the frame's document and
 * refusing {@link DROPPED}. Its default builds them in the host page — where an image
 * starts loading as soon as it has a `src`, attached or not.
 */
function factory(doc: Document): (elem: HElement | Node | string) => Node {
  const h = (elem: HElement | Node | string): Node => {
    if (typeof elem === 'string') return doc.createTextNode(elem);
    if (isNode(elem)) return elem;
    const { ns, tagName, className, style, children, ...props } = elem;
    if (tagName === '#fragment') {
      const fragment = doc.createDocumentFragment();
      for (const c of children ?? []) fragment.appendChild(h(c));
      return fragment;
    }
    if (tagName === '#comment' || DROPPED.has(tagName.toLowerCase())) {
      return doc.createComment('');
    }
    const el = ns
      ? doc.createElementNS(ns, tagName)
      : doc.createElement(tagName);
    if (className) el.setAttribute('class', className);
    if (typeof style === 'string') el.setAttribute('style', style);
    else if (style) Object.assign((el as HTMLElement).style, style);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || /^on/i.test(key) || key === 'srcdoc') continue;
      (el as unknown as Record<string, unknown>)[key] = value;
    }
    for (const c of children ?? []) el.appendChild(h(c));
    return el;
  };
  return h;
}

/** Apply {@link linkPolicy} to every link, after the library has finished with them. */
function secureLinks(doc: Document): void {
  for (const a of doc.querySelectorAll('a')) {
    const link = linkPolicy(a.getAttribute('href'));
    if (!link) {
      a.removeAttribute('href');
      continue;
    }
    a.setAttribute('href', link.href);
    if (link.external) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer nofollow');
    } else {
      // A srcdoc frame resolves `#x` against the host page's URL, so following it
      // navigates the frame. Scroll to the bookmark instead.
      const id = decodeURIComponent(link.href.slice(1));
      a.addEventListener('click', (event) => {
        event.preventDefault();
        doc.getElementById(id)?.scrollIntoView();
      });
    }
  }
}

/** Picture formats Word embeds and no browser draws. */
const UNDRAWABLE = /^data:image\/(x-wmf|x-emf|wmf|emf|pict|x-pict|tiff)/i;

/**
 * Word keeps vector clip art as WMF or EMF, which no browser can draw. Say what the
 * picture is rather than leave a bare broken-image icon.
 */
function labelUndrawable(doc: Document): void {
  for (const img of doc.querySelectorAll('img')) {
    const kind = UNDRAWABLE.exec(img.getAttribute('src') ?? '')?.[1];
    if (kind) {
      img.alt = `${kind.replace(/^x-/, '').toUpperCase()} picture, not shown`;
    }
  }
}

/** Parse the file, refusing what is not a Word document before the library sees it. */
export async function openWordDocument(file: File) {
  if (file.size > MAX_BYTES) {
    throw new Error('This document is too large to preview.');
  }
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    // An OLE compound file: Word wraps a password-protected .docx in one, and it is
    // also what a legacy .doc is. Either way it is Word, just not one we can open.
    const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    if (OLE.every((b, i) => head[i] === b)) {
      throw new Error(
        'This document is password-protected or in the legacy .doc format, which cannot be previewed.',
      );
    }
    throw new Error('This file is not a Word document.');
  }
  const types = await zip.file('[Content_Types].xml')?.async('string');
  if (!types || !isWordPackage(types)) {
    throw new Error('This file is not a Word document.');
  }
  return parseAsync(file, OPTIONS);
}

/**
 * A Word document, laid out in a sandboxed frame. Pages stay white whatever the theme,
 * because a document's colours assume paper, and shrink to fit a narrow container
 * rather than scrolling sideways.
 *
 * Loaded by `docxRenderer` — import that, not this, so `docx-preview` stays out of the
 * bundle until a Word document is opened.
 */
export function DocxFileView({ file }: FileViewProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [frameDoc, setFrameDoc] = useState<Document>();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    if (!frameDoc) return;
    let live = true;
    setReady(false);
    frameDoc.body.replaceChildren();
    for (const s of frameDoc.head.querySelectorAll('[data-docx]')) s.remove();

    openWordDocument(file)
      .then((doc) => renderDocument(doc, { ...OPTIONS, h: factory(frameDoc) }))
      .then((nodes) => {
        if (!live) return;
        for (const node of nodes) {
          if (node.nodeName === 'STYLE') {
            (node as Element).setAttribute('data-docx', '');
            frameDoc.head.appendChild(node);
          } else {
            frameDoc.body.appendChild(node);
          }
        }
        secureLinks(frameDoc);
        addGenericFonts(frameDoc);
        labelUndrawable(frameDoc);
        setReady(true);
      })
      .catch((e: unknown) => live && setError(e));
    return () => {
      live = false;
    };
  }, [file, frameDoc]);

  useFitWidth(frame, frameDoc, ready);
  useHostBackground(frame, frameDoc);

  // The preview's boundary turns this into a card with a download button.
  if (error !== undefined) throw error;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <iframe
        className="min-h-0 w-full flex-1 border-0 bg-muted"
        onLoad={(e) => {
          const doc = e.currentTarget.contentDocument;
          if (doc) setFrameDoc(doc);
        }}
        ref={frame}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={SHELL}
        title={file.name}
      />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-muted">
          <Spinner />
        </div>
      )}
      <p className="border-t px-3 py-1.5 text-xs text-muted-foreground">
        Layout is approximate. Download the file to see it exactly.
      </p>
    </div>
  );
}

/**
 * Shrink the pages to the frame's width when they are wider than it — a Letter page is
 * 816px, wider than any phone. Never enlarged: a page bigger than it is printed is not
 * easier to read.
 */
function useFitWidth(
  frame: RefObject<HTMLIFrameElement | null>,
  doc: Document | undefined,
  ready: boolean,
) {
  useEffect(() => {
    const el = frame.current;
    const wrapper = doc?.querySelector<HTMLElement>('.docx-wrapper');
    if (!el || !wrapper || !ready) return;
    const pages = [
      ...wrapper.querySelectorAll<HTMLElement>(':scope > section'),
    ];
    const widest = Math.max(0, ...pages.map((p) => p.offsetWidth));
    const resize = () => {
      // 32px: the wrapper's padding, which `zoom` scales along with the page.
      const scale = Math.min(1, el.clientWidth / (widest + 32));
      wrapper.style.zoom = widest > 0 && scale < 1 ? String(scale) : '';
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => observer.disconnect();
  }, [frame, doc, ready]);
}

/**
 * Paint the frame's background with the host's, and follow it when the theme changes.
 * The frame cannot read the page's CSS variables, and leaving it transparent is not
 * enough: when the frame's colour scheme differs from the page's, the browser paints an
 * opaque white backdrop behind it.
 */
function useHostBackground(
  frame: RefObject<HTMLIFrameElement | null>,
  doc: Document | undefined,
) {
  useEffect(() => {
    const el = frame.current;
    if (!el || !doc) return;
    const sync = () => {
      doc.documentElement.style.background =
        getComputedStyle(el).backgroundColor;
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    scheme.addEventListener('change', sync);
    return () => {
      observer.disconnect();
      scheme.removeEventListener('change', sync);
    };
  }, [frame, doc]);
}
