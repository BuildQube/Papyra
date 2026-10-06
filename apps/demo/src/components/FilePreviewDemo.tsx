// The descriptors are `.ts`, which the package's `./components/*` export (mapped to
// `.tsx`) does not reach, so they come in through the registry alias — the same
// specifier a consumer writes after `shadcn add`.

import { createFilePreview } from '@workspace/pdf-viewer/blocks/file-preview-create';
import { Button } from '@workspace/ui/components/button';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@workspace/ui/components/toggle-group';
import { PlusIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { audioRenderer } from '@/components/file-preview-audio';
import { codeRenderer } from '@/components/file-preview-code';
import { imageRenderer } from '@/components/file-preview-image';
import { pdfRenderer } from '@/components/file-preview-pdf';
import { videoRenderer } from '@/components/file-preview-video';
import type { RendererId } from '@/lib/file-preview-core';
import coreSource from '@/lib/file-preview-core?raw';
import type { FileSource, RemoteFile } from '@/lib/file-preview-source';
import { BlockPreview } from './BlockPreview.js';

const RENDERERS = [
  pdfRenderer,
  imageRenderer,
  videoRenderer,
  audioRenderer,
  codeRenderer,
] as const;
type Format = RendererId<typeof RENDERERS>;
const FORMATS: readonly Format[] = RENDERERS.map((r) => r.id);

const Preview = createFilePreview(RENDERERS);

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <rect width="120" height="120" rx="24" fill="#6ea8fe"/>
  <path d="M38 30h30a22 22 0 0 1 0 44H52v16H38z M52 44v16h16a8 8 0 0 0 0-16z" fill="#fff"/>
</svg>
`;

/**
 * A second of a rising tone, as a 16-bit mono WAV — synthesised rather than shipped,
 * like the gradient, and handed over as a `File` so the audio renderer exercises the
 * object-URL path while the video exercises streaming from a URL.
 */
function toneWav(): File {
  const rate = 22050;
  const samples = rate;
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  let phase = 0;
  for (let i = 0; i < samples; i++) {
    const t = i / samples;
    phase += (2 * Math.PI * (330 + 330 * t)) / rate;
    const fade = Math.min(1, t * 20, (1 - t) * 20);
    view.setInt16(44 + i * 2, Math.sin(phase) * fade * 0.3 * 32767, true);
  }
  return new File([view.buffer], 'tone.wav', { type: 'audio/wav' });
}

/** A gradient, drawn rather than shipped, so the demo carries no image asset. */
async function gradientPng(): Promise<File> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 400;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 640, 400);
    g.addColorStop(0, '#6ea8fe');
    g.addColorStop(1, '#1f2937');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 640, 400);
  }
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/png'),
  );
  return new File([blob ?? new Blob()], 'gradient.png', { type: 'image/png' });
}

/**
 * The file preview over every kind of source: a plain URL, a signed URL minted on
 * demand, `File`s of several formats, an HTML page posing as a PNG, and a
 * cross-origin URL whose server does not allow CORS.
 *
 * The controls sit above the frame because they are this page's, not the block's —
 * an app decides `allow` in code and owns its own way of adding files.
 */
export function FilePreviewDemo() {
  const base = import.meta.env.BASE_URL;
  const [minted, setMinted] = useState(0);
  const [local, setLocal] = useState<File[]>([]);
  const [added, setAdded] = useState<File[]>([]);
  const [allow, setAllow] = useState<Format[]>([...FORMATS]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void gradientPng().then(
      (png) =>
        live &&
        setLocal([
          png,
          new File([LOGO], 'logo.svg', { type: 'image/svg+xml' }),
          toneWav(),
          new File([coreSource], 'file-preview-core.ts', {
            type: 'text/plain',
          }),
          // An HTML page with an image's name and MIME type: the sniffer refuses it.
          new File(
            ['<!doctype html><h1>not a picture</h1>'],
            'not-really.png',
            {
              type: 'image/png',
            },
          ),
        ]),
    );
    return () => {
      live = false;
    };
  }, []);

  // Stable across renders by `key`, which is what the cache recognises — the
  // resolver itself could be a new function every time and nothing would refetch.
  const signed = useMemo<RemoteFile>(
    () => ({
      key: 'demo:signed-sample',
      name: 'signed-sample.pdf',
      url: async () => {
        setMinted((n) => n + 1);
        // A real one would ask a backend for a fresh signature.
        await new Promise((r) => setTimeout(r, 300));
        return `${base}sample.pdf?expires=${Date.now() + 60_000}&sig=demo`;
      },
    }),
    [base],
  );

  const files: FileSource[] = [
    `${base}sample.pdf`,
    signed,
    // Four seconds of ffmpeg's test pattern and a tone, made with:
    //   ffmpeg -f lavfi -i testsrc2=size=320x180:rate=24:duration=4 \
    //     -f lavfi -i sine=frequency=440:duration=4 -c:v libvpx-vp9 -b:v 0 \
    //     -crf 45 -c:a libopus -b:a 32k -shortest sample.webm
    `${base}sample.webm`,
    ...local,
    // No CORS headers on that server, so the browser will not hand over the bytes.
    'https://example.com/report.pdf',
    ...added,
  ];

  const add = (more: FileList | null) => {
    if (!more?.length) return;
    setIndex(files.length);
    setAdded([...added, ...more]);
  };

  return (
    // A drop target: the files land in the list, and the "Add files" button is the
    // keyboard route to the same place.
    <section
      aria-label="Drop files to preview them"
      className="mt-3"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        add(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Demo controls</span>
        <span>· allow</span>
        <ToggleGroup
          multiple
          onValueChange={(value) => setAllow(value as Format[])}
          size="sm"
          value={allow}
          variant="outline"
        >
          {RENDERERS.map((r) => (
            <ToggleGroupItem key={r.id} value={r.id}>
              {r.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="tabular-nums">
          · signed link minted {minted} {minted === 1 ? 'time' : 'times'}
        </span>
        <Button
          className="ml-auto"
          onClick={() => input.current?.click()}
          size="sm"
          variant="outline"
        >
          <PlusIcon />
          Add files
        </Button>
        {/* No `accept`: the point is to try files the preview should refuse. */}
        <input
          className="hidden"
          multiple
          onChange={(e) => add(e.target.files)}
          ref={input}
          type="file"
        />
      </div>
      <BlockPreview>
        <Preview
          allow={allow}
          className="min-h-0 flex-1"
          files={files}
          index={index}
          onIndexChange={setIndex}
        />
      </BlockPreview>
    </section>
  );
}
