import {
  ChevronLeftIcon,
  ChevronRightIcon,
  MinusIcon,
  PlusIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  FIT_MODES,
  formatZoom,
  isFitMode,
  MAX_ZOOM,
  MIN_ZOOM,
  type ViewMode,
  ZOOM_STEPS,
  type ZoomSpec,
} from '@/lib/pdf-zoom';
import { cn } from '@/lib/utils';

/** Props for {@link ZoomBar}. */
export interface ZoomBarProps {
  /** What the reader asked for: a fixed percentage, or a fit mode. */
  spec: ZoomSpec;
  /** The resolved scale, which is what a fit mode actually came out as. */
  scale: number;
  /** The current page, 0-based. */
  page: number;
  /** How many pages the document has. */
  pageCount: number;
  /**
   * The label printed on this page, when the document numbers its pages as something
   * other than their index. Empty when it does not, so nothing is shown.
   */
  label: string;
  /** Which view is mounted. */
  mode: ViewMode;
  /** True while the pages on screen are a stretched bitmap awaiting a re-render. */
  settling: boolean;
  /** Called when a zoom level or fit mode is chosen. */
  onSpec: (spec: ZoomSpec) => void;
  /** Called to step one rung up the zoom ladder. */
  onStepIn: () => void;
  /** Called to step one rung down. */
  onStepOut: () => void;
  /** Called with a 0-based page index when the pager moves. */
  onPage: (index: number) => void;
  /** Called when the single/continuous toggle changes. */
  onMode: (mode: ViewMode) => void;
}

const FIT_LABELS: Record<string, string> = {
  auto: 'Automatic',
  'page-fit': 'Page fit',
  'page-width': 'Page width',
};

/**
 * A viewer toolbar: pager, zoom steppers, fit-mode select and the view toggle.
 *
 * Entirely controlled — it holds no zoom state of its own, so the same bar drives a
 * single-page view and a continuous one.
 */
export function ZoomBar({
  spec,
  scale,
  page,
  pageCount,
  label,
  mode,
  settling,
  onSpec,
  onStepIn,
  onStepOut,
  onPage,
  onMode,
}: ZoomBarProps) {
  const custom =
    typeof spec === 'number' && !ZOOM_STEPS.includes(spec) ? spec : null;

  return (
    <>
      <ButtonGroup>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous page"
          disabled={page <= 0}
          onClick={() => onPage(page - 1)}
        >
          <ChevronLeftIcon />
        </Button>
        <InputGroup className="h-7 w-28">
          <InputGroupInput
            type="number"
            aria-label="Page number"
            className="text-right tabular-nums"
            min={1}
            max={pageCount}
            value={page + 1}
            onChange={(e) => {
              const next = Number(e.target.value) - 1;
              if (Number.isInteger(next) && next >= 0 && next < pageCount) {
                onPage(next);
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            <InputGroupText>of {pageCount}</InputGroupText>
          </InputGroupAddon>
        </InputGroup>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next page"
          disabled={page >= pageCount - 1}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRightIcon />
        </Button>
      </ButtonGroup>

      {label && (
        <Badge variant="outline" title="The number printed on this page">
          {label}
        </Badge>
      )}

      <ButtonGroup>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Zoom out"
          disabled={scale <= MIN_ZOOM}
          onClick={onStepOut}
        >
          <MinusIcon />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Zoom in"
          disabled={scale >= MAX_ZOOM}
          onClick={onStepIn}
        >
          <PlusIcon />
        </Button>
      </ButtonGroup>

      {/* Values cross as strings, as they did through the native `<select>` this
          replaces: a fit mode and a scale share one control, and one type of option
          value is less to go wrong than a union that has to survive inference. */}
      <Select
        value={String(spec)}
        onValueChange={(value) =>
          onSpec(isFitMode(value) ? value : Number(value))
        }
      >
        <SelectTrigger
          size="sm"
          aria-label="Zoom"
          // The pages on screen are a stretched bitmap until the gesture settles.
          className={cn('w-40', settling && 'border-primary')}
        >
          <SelectValue>{describeZoom(spec, scale)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Fit</SelectLabel>
            {FIT_MODES.map((fit) => (
              <SelectItem key={fit} value={fit}>
                {FIT_LABELS[fit] ?? fit}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Zoom</SelectLabel>
            {custom !== null && (
              <SelectItem value={String(custom)}>
                {formatZoom(custom)}
              </SelectItem>
            )}
            {ZOOM_STEPS.map((step) => (
              <SelectItem key={step} value={String(step)}>
                {formatZoom(step)}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>

      <ToggleGroup
        variant="outline"
        size="sm"
        spacing={0}
        value={[mode]}
        onValueChange={(value) => {
          // A toggle group can be emptied by clicking the active item; this one is a
          // segmented control, so the current mode stands rather than falling to none.
          const next = value[0];
          if (next) onMode(next as ViewMode);
        }}
      >
        <ToggleGroupItem value="page">Single</ToggleGroupItem>
        <ToggleGroupItem value="scroll">Continuous</ToggleGroupItem>
      </ToggleGroup>

      <span className="ml-auto flex items-center gap-1 text-xs whitespace-nowrap text-muted-foreground">
        <Kbd>⌘/ctrl</Kbd> + scroll, pinch, or <Kbd>⌘/ctrl</Kbd>
        <Kbd>+</Kbd>/<Kbd>−</Kbd> to zoom
      </span>
    </>
  );
}

/** What the trigger reads: a fit mode also says what it actually came out as. */
function describeZoom(spec: ZoomSpec, scale: number): string {
  if (typeof spec === 'number') return formatZoom(spec);
  return `${FIT_LABELS[spec] ?? spec} · ${formatZoom(scale)}`;
}
