import type { ReactElement } from 'react';
import { FilePreview, type FilePreviewProps } from '@/components/file-preview';
import type { FileRenderer, RendererId } from '@/lib/file-preview-core';

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

/**
 * Bind a renderer list into a preview component, whose `allow` accepts exactly the
 * ids in that list.
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
 * ```
 *
 * The list is the whole of what this preview can show, and the type and the runtime
 * read the same array — a format is allowed only if it is passed here, never merely
 * because its file is installed. Call it once, at module scope.
 */
export function createFilePreview<const R extends readonly FileRenderer[]>(
  renderers: R & UniqueRenderers<R>,
): (props: FilePreviewProps<RendererId<R>>) => ReactElement {
  const ids = renderers.map((r) => r.id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw new Error(`file preview: duplicate renderer id "${twice}"`);

  function BoundFilePreview(props: FilePreviewProps<RendererId<R>>) {
    return <FilePreview renderers={renderers} {...props} />;
  }
  return BoundFilePreview;
}
