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
import { useEffect, useRef, useState } from 'react';
import { codeRenderer } from '@/components/file-preview-code';
import { imageRenderer } from '@/components/file-preview-image';
import { pdfRenderer } from '@/components/file-preview-pdf';
import type { RendererId } from '@/lib/file-preview-core';
import coreSource from '@/lib/file-preview-core?raw';

const RENDERERS = [pdfRenderer, imageRenderer, codeRenderer] as const;
type Format = RendererId<typeof RENDERERS>;
const FORMATS: readonly Format[] = RENDERERS.map((r) => r.id);

const Preview = createFilePreview(RENDERERS);

const LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
  <rect width="120" height="120" rx="24" fill="#6ea8fe"/>
  <path d="M38 30h30a22 22 0 0 1 0 44H52v16H38z M52 44v16h16a8 8 0 0 0 0-16z" fill="#fff"/>
</svg>
`;

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

async function sampleFiles(): Promise<File[]> {
  const pdf = await fetch(`${import.meta.env.BASE_URL}sample.pdf`)
    .then((res) => res.blob())
    .then((b) => new File([b], 'sample.pdf', { type: 'application/pdf' }));
  return [
    pdf,
    await gradientPng(),
    new File([LOGO], 'logo.svg', { type: 'image/svg+xml' }),
    new File([coreSource], 'file-preview-core.ts', { type: 'text/plain' }),
    // An HTML page with an image's name and MIME type: the sniffer refuses it.
    new File(['<!doctype html><h1>not a picture</h1>'], 'not-really.png', {
      type: 'image/png',
    }),
  ];
}

/**
 * The file preview over a mixed set: a PDF, two images, source code and an HTML
 * page posing as a PNG. Toggling a format off shows the refusal card; files dropped
 * or picked here join the list.
 */
export function FilePreviewDemo() {
  const [files, setFiles] = useState<File[]>([]);
  const [allow, setAllow] = useState<Format[]>([...FORMATS]);
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    void sampleFiles().then((f) => live && setFiles(f));
    return () => {
      live = false;
    };
  }, []);

  const add = (more: FileList | null) => {
    if (!more?.length) return;
    setIndex(files.length);
    setFiles([...files, ...more]);
  };

  return (
    // A drop target: the files land in the list, and the "Add files" button is the
    // keyboard route to the same place.
    <section
      aria-label="Drop files to preview them"
      className="flex min-w-0 flex-1 flex-col"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        add(e.dataTransfer.files);
      }}
    >
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-2 py-1.5">
        <span className="text-xs text-muted-foreground">Allow</span>
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
        <Button
          className="ml-auto"
          onClick={() => input.current?.click()}
          size="sm"
          variant="ghost"
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
      <Preview
        allow={allow}
        className="min-h-0 flex-1"
        files={files}
        index={index}
        onIndexChange={setIndex}
      />
    </section>
  );
}
