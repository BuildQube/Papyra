import type { EncodedFormat } from '@build-qube/papyra';
import { Button } from '@workspace/ui/components/button';
import {
  FieldDescription,
  FieldLegend,
  FieldSet,
} from '@workspace/ui/components/field';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@workspace/ui/components/input-group';
import { Slider } from '@workspace/ui/components/slider';
import { Spinner } from '@workspace/ui/components/spinner';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@workspace/ui/components/toggle-group';
import { DownloadIcon } from 'lucide-react';

const FORMATS: readonly EncodedFormat[] = ['webp', 'png', 'jpeg', 'svg'];

/**
 * WebP here is lossless VP8L and PNG is Deflate — neither takes a quality setting, so
 * the slider hides rather than sitting inert.
 */
const isLossy = (format: EncodedFormat) => format === 'jpeg';

const BLURB: Record<EncodedFormat, string> = {
  webp: 'Lossless, so there is nothing to trade away.',
  png: 'Lossless, so there is nothing to trade away.',
  jpeg: 'Lossy. The only pure-Rust option with a quality knob.',
  svg: 'Vector. Paths stay paths, so it scales without resampling — and width does not apply.',
};

interface Props {
  format: EncodedFormat;
  quality: number;
  width: number;
  transparent: boolean;
  busy: boolean;
  onFormat: (format: EncodedFormat) => void;
  onQuality: (quality: number) => void;
  onWidth: (width: number) => void;
  onTransparent: (transparent: boolean) => void;
  onDownload: () => void;
}

export function ExportControls({
  format,
  quality,
  width,
  transparent,
  busy,
  onFormat,
  onQuality,
  onWidth,
  onTransparent,
  onDownload,
}: Props) {
  return (
    /*
     * A docked panel rather than a `Card`: it runs the full height of the workspace
     * against the page area, and a rounded, shadowed card floating in that slot reads
     * as something you could move. Fixed 320px basis — sized by content, a single long
     * blurb widens it until the page area is squeezed to nothing.
     */
    <section className="flex w-80 min-w-56 flex-none flex-col gap-4 overflow-y-auto border-l bg-card p-3">
      <h2 className="font-heading text-sm font-medium">Encode</h2>

      <FieldSet>
        <FieldLegend variant="label">Format</FieldLegend>
        <ToggleGroup
          variant="outline"
          size="sm"
          spacing={0}
          className="w-full *:flex-1"
          value={[format]}
          onValueChange={(value) => {
            const next = value[0];
            if (next) onFormat(next as EncodedFormat);
          }}
        >
          {FORMATS.map((f) => (
            <ToggleGroupItem key={f} value={f}>
              {f}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldDescription>{BLURB[format]}</FieldDescription>
      </FieldSet>

      {isLossy(format) && (
        <FieldSet>
          <FieldLegend variant="label">Quality {quality}</FieldLegend>
          <Slider
            min={1}
            max={100}
            value={quality}
            onValueChange={(value) =>
              onQuality(typeof value === 'number' ? value : (value[0] ?? 1))
            }
          />
        </FieldSet>
      )}

      {format === 'svg' && (
        <FieldSet>
          <FieldLegend variant="label">Background</FieldLegend>
          <ToggleGroup
            variant="outline"
            size="sm"
            spacing={0}
            className="w-full *:flex-1"
            value={[transparent ? 'transparent' : 'white']}
            onValueChange={(value) => {
              const next = value[0];
              if (next) onTransparent(next === 'transparent');
            }}
          >
            <ToggleGroupItem value="white">white</ToggleGroupItem>
            <ToggleGroupItem value="transparent">transparent</ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription>
            White matches how pages rasterise. Drop it when the SVG goes on top
            of something else — the checkerboard is the viewer, not the file.
          </FieldDescription>
        </FieldSet>
      )}

      {format !== 'svg' && (
        <FieldSet>
          <FieldLegend variant="label">Width</FieldLegend>
          <InputGroup>
            <InputGroupInput
              type="number"
              aria-label="Output width"
              className="tabular-nums"
              min={64}
              max={6000}
              step={100}
              value={width}
              onChange={(e) => onWidth(Number(e.target.value))}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupText>px</InputGroupText>
            </InputGroupAddon>
          </InputGroup>
          <FieldDescription>
            Output pixels, not DPI. A fixed DPI explodes on large-format pages.
          </FieldDescription>
        </FieldSet>
      )}

      <Button variant="outline" onClick={onDownload} disabled={busy}>
        {busy ? (
          <Spinner data-icon="inline-start" />
        ) : (
          <DownloadIcon data-icon="inline-start" />
        )}
        Download .{format === 'jpeg' ? 'jpg' : format}
      </Button>
    </section>
  );
}
