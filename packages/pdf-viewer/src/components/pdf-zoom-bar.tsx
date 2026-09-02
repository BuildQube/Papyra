import type { Rotation } from '@build-qube/papyra';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  InfoIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  RotateCwIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  /** Which view is mounted. Only meaningful alongside `onMode`. */
  mode?: ViewMode;
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
  /**
   * Called when the single/continuous choice changes.
   *
   * Omit it and the choice is not offered — a viewer fixed to one view should not
   * show a control that does nothing.
   */
  onMode?: (mode: ViewMode) => void;
  /** The rotation currently applied, so the menu can name it. */
  rotation?: Rotation;
  /**
   * Called with a quarter turn, positive for clockwise.
   *
   * Omit it and the rotate items are not rendered, on the same principle as
   * {@link onMode}.
   */
  onRotate?: (quarters: 1 | -1) => void;
  /** Whether the document's own annotations are being drawn. */
  annotations?: boolean;
  /**
   * Called when the annotations switch changes.
   *
   * Omit it and the switch is not rendered.
   */
  onAnnotations?: (on: boolean) => void;
  /**
   * Called when "Document properties…" is picked.
   *
   * The dialog itself is the application's — it knows the file name and size, which
   * the document does not carry. Omit it and the item is not rendered.
   */
  onProperties?: () => void;
}

const FIT_LABELS: Record<string, string> = {
  auto: 'Automatic',
  'page-fit': 'Page fit',
  'page-width': 'Page width',
};

/**
 * A viewer toolbar: pager, zoom steppers, fit-mode select, and a more menu.
 *
 * Entirely controlled — it holds no zoom state of its own, so the same bar drives a
 * single-page view and a continuous one.
 *
 * Rotation, the annotation switch, the view mode and document properties live behind
 * the menu at every width, not only narrow ones. One arrangement is one to learn, and
 * with them inline the bar wrapped to a second row on anything under ~900px — which
 * is the worst outcome a toolbar has.
 *
 * What does shrink with the container is expressed as `@max-md/pdf-viewer:` rather
 * than `@md/pdf-viewer:`: the second form hides a control until a container named
 * `pdf-viewer` says otherwise, so a consumer mounting this bar in a frame of their
 * own would lose the zoom steppers for good. The first form hides nothing unless
 * that container exists and is narrow.
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
  rotation = 0,
  onRotate,
  annotations = true,
  onAnnotations,
  onProperties,
}: ZoomBarProps) {
  const custom =
    typeof spec === 'number' && !ZOOM_STEPS.includes(spec) ? spec : null;
  const more = onRotate || onMode || onAnnotations || onProperties;

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
        <Badge
          variant="outline"
          title="The number printed on this page"
          className="@max-md/pdf-viewer:hidden"
        >
          {label}
        </Badge>
      )}

      {/* Pinch and ⌘-scroll cover this on a narrow viewer, and the select still
          offers every step. */}
      <ButtonGroup className="@max-md/pdf-viewer:hidden">
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

      <Select
        value={String(spec)}
        onValueChange={(value) =>
          onSpec(isFitMode(value) ? value : Number(value))
        }
      >
        <SelectTrigger
          size="sm"
          aria-label="Zoom"
          className={cn(
            'w-40 @max-md/pdf-viewer:w-22',
            settling && 'border-primary',
          )}
        >
          <SelectValue>
            <span className="@max-md/pdf-viewer:hidden">
              {describeZoom(spec, scale)}
            </span>
            <span className="hidden @max-md/pdf-viewer:inline">
              {formatZoom(scale)}
            </span>
          </SelectValue>
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

      <div className="ml-auto flex items-center gap-2.5">
        {/* Not on a coarse pointer, where there is no ⌘ to hold, and not where the
            bar is narrow enough that it would be the thing wrapping. */}
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground @max-xl/pdf-viewer:hidden pointer-coarse:hidden">
          <Kbd>⌘/ctrl</Kbd> + scroll, pinch, or <Kbd>⌘/ctrl</Kbd>
          <Kbd>+</Kbd>/<Kbd>−</Kbd> to zoom
        </span>

        {more && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="More tools"
                  className="data-popup-open:bg-muted"
                />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            {/* Wide enough that the annotation item is one line; the
                popup's natural width is its shortest item's. */}
            <DropdownMenuContent align="end" className="min-w-64">
              {onRotate && (
                <DropdownMenuGroup>
                  <DropdownMenuLabel>
                    Rotation{rotation !== 0 && ` · ${rotation}°`}
                  </DropdownMenuLabel>
                  <DropdownMenuItem onClick={() => onRotate(1)}>
                    <RotateCwIcon />
                    Rotate clockwise
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onRotate(-1)}>
                    <RotateCcwIcon />
                    Rotate counter-clockwise
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              )}
              {onMode && (
                <>
                  {onRotate && <DropdownMenuSeparator />}
                  <DropdownMenuRadioGroup
                    value={mode ?? 'scroll'}
                    onValueChange={(value) => onMode(value as ViewMode)}
                  >
                    <DropdownMenuRadioItem value="page">
                      Single page
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="scroll">
                      Continuous
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </>
              )}
              {onAnnotations && (
                <>
                  {(onRotate || onMode) && <DropdownMenuSeparator />}
                  <DropdownMenuCheckboxItem
                    checked={annotations}
                    onCheckedChange={(checked) => onAnnotations(checked)}
                  >
                    Draw the document's annotations
                  </DropdownMenuCheckboxItem>
                </>
              )}
              {onProperties && (
                <>
                  {(onRotate || onMode || onAnnotations) && (
                    <DropdownMenuSeparator />
                  )}
                  <DropdownMenuItem onClick={onProperties}>
                    <InfoIcon />
                    Document properties…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </>
  );
}

/** What the trigger reads: a fit mode also says what it actually came out as. */
function describeZoom(spec: ZoomSpec, scale: number): string {
  if (typeof spec === 'number') return formatZoom(spec);
  return `${FIT_LABELS[spec] ?? spec} · ${formatZoom(scale)}`;
}
