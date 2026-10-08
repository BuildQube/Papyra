import type { ReactElement } from 'react';
import { FilePreview, type FilePreviewProps } from '@/components/file-preview';
import type {
  FileRenderer,
  RendererId,
  RendererOptions,
} from '@/lib/file-preview-core';

/** Every renderer id that appears more than once in `R`, as a union. */
export type DuplicateIds<
  R extends readonly FileRenderer[],
  Seen extends string = never,
> = R extends readonly [
  infer Head extends FileRenderer,
  ...infer Tail extends readonly FileRenderer[],
]
  ?
      | (Head['id'] extends Seen ? Head['id'] : never)
      | DuplicateIds<Tail, Seen | Head['id']>
  : never;

/**
 * `R`, unless two of its renderers share an id — in which case a type whose name is
 * the error message, so the mistake surfaces at the call rather than as one format
 * silently shadowing another.
 */
export type UniqueRenderers<R extends readonly FileRenderer[]> = [
  DuplicateIds<R>,
] extends [never]
  ? R
  : {
      /** The id two renderers share: the error, spelled out in the type. */
      'duplicate renderer id': DuplicateIds<R>;
    };

/** The props of a preview bound to the renderer list `R`. */
export type BoundFilePreviewProps<R extends readonly FileRenderer[]> =
  FilePreviewProps<RendererId<R>, RendererOptions<R>>;

/**
 * What {@link createFilePreview} can fix for every preview it makes: the settings
 * an app decides once, rather than the files and position each instance has.
 */
export type FilePreviewDefaults<R extends readonly FileRenderer[]> = Pick<
  BoundFilePreviewProps<R>,
  | 'allow'
  | 'options'
  | 'cache'
  | 'fullscreen'
  | 'displaySize'
  | 'displayRenderTime'
>;

/**
 * Bind a renderer list into a preview component, whose `allow` accepts exactly the
 * ids in that list and whose `options` accepts each one's view options.
 *
 * ```tsx
 * import { codeRenderer } from '@/components/file-preview-code';
 * import { imageRenderer } from '@/components/file-preview-image';
 * import { pdfRenderer } from '@/components/file-preview-pdf';
 *
 * // Order is priority: anything recognisable by its bytes goes before `code`.
 * const Preview = createFilePreview([pdfRenderer, imageRenderer, codeRenderer]);
 *
 * <Preview files={files} allow={['pdf', 'image']} />   // fine
 * <Preview files={files} allow={['docx']} />           // type error
 * <Preview files={files} options={{ pdf: { thumbnails: true } }} />
 * ```
 *
 * `defaults` sets any of `allow`, `options`, `cache`, `fullscreen`, `displaySize`
 * and `displayRenderTime` for every preview this returns:
 *
 * ```tsx
 * const Preview = createFilePreview([pdfRenderer, imageRenderer], {
 *   displaySize: true,
 *   options: { pdf: { search: true } },
 * });
 * ```
 *
 * A prop on the instance wins over a default, and one left `undefined` does not
 * count as set. `options` merge per renderer, field by field, in order of
 * precedence: the renderer's `with`, then these defaults, then the instance's.
 *
 * The list is the whole of what this preview can show, and the type and the runtime
 * read the same array — a format is allowed only if it is passed here, never merely
 * because its file is installed. Call it once, at module scope.
 */
export function createFilePreview<const R extends readonly FileRenderer[]>(
  renderers: R & UniqueRenderers<R>,
  defaults: FilePreviewDefaults<R> = {},
): (props: BoundFilePreviewProps<R>) => ReactElement {
  const ids = renderers.map((r) => r.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw new Error(`file preview: duplicate renderer id "${twice}"`);

  function BoundFilePreview(props: BoundFilePreviewProps<R>) {
    return (
      <FilePreview
        renderers={renderers}
        {...mergePreviewProps(defaults, props)}
      />
    );
  }
  return BoundFilePreview;
}

/**
 * An instance's props over the defaults: set ones win, `undefined` ones do not
 * count, and `options` merge per renderer id rather than replacing wholesale — a
 * preview that turns on PDF search should not lose the PDF thumbnails its app
 * default turned on.
 */
export function mergePreviewProps<P extends object>(
  defaults: Partial<P>,
  props: P,
): P {
  const merged: Record<string, unknown> = { ...defaults };
  for (const [key, value] of Object.entries(props)) {
    if (value !== undefined) merged[key] = value;
  }
  type WithOptions = { options?: Record<string, object> };
  const base = (defaults as WithOptions).options;
  const own = (props as WithOptions).options;
  if (base && own) {
    const options: Record<string, object> = { ...base };
    for (const [id, value] of Object.entries(own)) {
      options[id] = { ...base[id], ...value };
    }
    merged.options = options;
  }
  return merged as P;
}
