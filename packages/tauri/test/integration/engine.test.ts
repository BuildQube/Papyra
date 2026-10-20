import { beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  IncorrectPasswordError,
  PasswordRequiredError,
} from '@build-qube/papyra/core';

/**
 * `TauriEngine` against a stand-in for the plugin: Tauri's IPC is mocked, and so is
 * the page fetch. The plugin's own side is tested in Rust; this checks the contract
 * between them — which commands, which arguments, which shapes.
 *
 * In `test/integration` only because it imports `@build-qube/papyra/core`, which
 * needs papyra's TypeScript built; it needs no addon and no corpus.
 */
type Call = { cmd: string; args: unknown; options?: unknown };
const calls: Call[] = [];
let answers: Record<string, (args: unknown) => unknown> = {};

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args: unknown, options?: unknown) => {
    calls.push({ cmd, args, options });
    const answer = answers[cmd];
    if (!answer) throw new Error(`no answer for ${cmd}`);
    return answer(args);
  },
  convertFileSrc: (path: string, protocol: string) =>
    `${protocol}://localhost/${path}`,
}));

const { TauriEngine } = await import('../../src/index.js');

const OPENED = {
  id: 7,
  sizes: [
    [612, 792],
    [792, 612],
  ],
  info: { title: 'Plans', author: null },
  pdfVersion: '1.7',
};

beforeEach(() => {
  calls.length = 0;
  answers = { 'plugin:papyra|open': () => OPENED };
});

describe('TauriEngine', () => {
  test('is available only inside a Tauri WebView', () => {
    expect(new TauriEngine().availability().ok).toBe(false);
    Object.assign(globalThis, { __TAURI_INTERNALS__: {} });
    expect(new TauriEngine().availability().ok).toBe(true);
    delete (globalThis as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__;
  });

  test('opens by sending the bytes as the body, and the password as a header', async () => {
    const engine = new TauriEngine();
    const doc = await engine.open(new Uint8Array([1, 2, 3]), {
      password: 'pässwort',
    });
    const [open] = calls;
    expect(open?.cmd).toBe('plugin:papyra|open');
    expect(open?.args).toEqual(new Uint8Array([1, 2, 3]));
    expect(open?.options).toEqual({
      headers: { 'x-papyra-password': 'p%C3%A4sswort' },
    });

    expect(doc.engine).toBe('tauri');
    expect(doc.pageCount).toBe(2);
    expect(doc.pageSize(1)).toEqual({ width: 792, height: 612 });
    expect(doc.metadata.title).toBe('Plans');
    expect(doc.metadata.author).toBeNull();
    expect(doc.pdfVersion).toBe('1.7');
    expect(doc.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  test('a tagged password failure becomes papyra’s typed error', async () => {
    const engine = new TauriEngine();
    answers['plugin:papyra|open'] = () => {
      throw 'papyra/password-required this PDF is password-protected';
    };
    expect(engine.open(new Uint8Array())).rejects.toBeInstanceOf(
      PasswordRequiredError,
    );
    answers['plugin:papyra|open'] = () => {
      throw 'papyra/incorrect-password the supplied password is incorrect';
    };
    expect(engine.open(new Uint8Array())).rejects.toBeInstanceOf(
      IncorrectPasswordError,
    );
  });

  test('renders by fetching the page from the papyra protocol', async () => {
    const urls: string[] = [];
    const fetched = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(new Uint8Array(612 * 792 * 4), {
        headers: { 'x-width': '612', 'x-height': '792' },
      });
    }) as never;
    try {
      const engine = new TauriEngine({ format: 'rgba' });
      const doc = await engine.open(new Uint8Array());
      const page = await engine.render(doc, 0, {
        fitWidth: 612,
        annotations: false,
      }).promise;
      expect(urls).toEqual([
        'papyra://localhost/7/0?dpi=72&annots=0&format=rgba',
      ]);
      expect(page).toMatchObject({ width: 612, height: 792, stride: 2448 });
      expect('data' in page && page.data.byteLength).toBe(612 * 792 * 4);
    } finally {
      globalThis.fetch = fetched;
    }
  });

  test('a failed page render rejects with the host’s message', async () => {
    const fetched = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('page 9 out of range', { status: 422 })) as never;
    try {
      const engine = new TauriEngine();
      const doc = await engine.open(new Uint8Array());
      expect(engine.render(doc, 1).promise).rejects.toThrow(
        'page 9 out of range',
      );
    } finally {
      globalThis.fetch = fetched;
    }
  });

  test('reads text, links and the outline through the plugin’s commands', async () => {
    answers['plugin:papyra|page_text'] = () => ({
      lines: [
        {
          text: 'hi',
          offsets: [0, 5, 10],
          x: 1,
          y: 2,
          dx: 1,
          dy: 0,
          ascent: 8,
          descent: 2,
        },
      ],
      undecodedGlyphs: 0,
    });
    answers['plugin:papyra|links'] = () => [
      { x0: 0, y0: 0, x1: 10, y1: 5, uri: 'https://example.com', alt: null },
    ];
    answers['plugin:papyra|outline'] = () => [
      {
        title: 'One',
        level: 0,
        dest: null,
        bold: false,
        italic: false,
        open: true,
      },
      {
        title: 'Two',
        level: 1,
        dest: null,
        bold: false,
        italic: false,
        open: true,
      },
    ];
    const engine = new TauriEngine();
    const doc = await engine.open(new Uint8Array());

    const text = await engine.pageText(doc, 1);
    expect(text.page).toBe(1);
    expect(text.lines[0]?.offsets).toBeInstanceOf(Float32Array);
    expect(calls.at(-1)).toMatchObject({ args: { id: 7, index: 1 } });

    const [link] = await engine.links(doc, 0);
    expect(link?.target).toEqual({ kind: 'uri', uri: 'https://example.com' });

    const outline = await engine.outline(doc);
    expect(outline[0]?.children[0]?.title).toBe('Two');
  });

  test('closing the document releases it in the host', async () => {
    answers['plugin:papyra|close'] = () => null;
    const engine = new TauriEngine();
    const doc = await engine.open(new Uint8Array());
    engine.close(doc);
    expect(calls.at(-1)).toMatchObject({
      cmd: 'plugin:papyra|close',
      args: { id: 7 },
    });
  });
});
