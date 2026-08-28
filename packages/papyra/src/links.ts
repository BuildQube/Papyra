import type { PageLink as NativePageLink } from '@build-qube/papyra-native';
import { type OutlineDestination, toDestination } from './outline.js';
import type { Rect } from './text.js';

/**
 * Where a link goes.
 *
 * A discriminated union rather than two nullable fields, so narrowing on `kind` gives
 * you the payload without a non-null assertion:
 *
 * ```ts
 * if (link.target.kind === 'uri') window.open(link.target.uri);
 * else void doc.render(link.target.dest.page, { fitWidth: 1600 });
 * ```
 */
export type LinkTarget =
  | {
      /** The link points somewhere in this document. */
      readonly kind: 'internal';
      /** The page and the view, in the same shape an outline entry uses. */
      readonly dest: OutlineDestination;
    }
  | {
      /**
       * The link points out of this document.
       *
       * Not necessarily `http`: `mailto:` and `file:` are both common, and papyra
       * does not validate the string. Decide for yourself what you are willing to
       * follow before handing it to a browser.
       */
      readonly kind: 'uri';
      /** The URI, exactly as the document wrote it. */
      readonly uri: string;
    };

/**
 * One link on a page: a clickable region, and what it does.
 *
 * Only links that resolve to something actionable are reported — a `/Link` pointing
 * at a page the document does not contain, or carrying an action papyra does not act
 * on, is dropped rather than handed over as a region that would swallow clicks.
 */
export interface PageLink {
  /**
   * The clickable region, in the same 72-DPI top-left space as {@link PageText} and
   * {@link PageSize}. Multiply by `rendered.width / pageSize.width` to place it over
   * a render — {@link scaleRect} does exactly that.
   */
  readonly rect: Rect;
  /** Where activating the link goes. Narrow on `target.kind`. */
  readonly target: LinkTarget;
  /** The annotation's tooltip, when it has one. */
  readonly alt: string | null;
}

/** @internal */
export function toPageLink(native: NativePageLink): PageLink | null {
  const target = linkTarget(native);
  // The bindings only emit a link with one target or the other, so this is
  // unreachable in practice; dropping it beats widening the type with a null target.
  if (!target) return null;
  return {
    rect: {
      x: native.x0,
      y: native.y0,
      width: native.x1 - native.x0,
      height: native.y1 - native.y0,
    },
    target,
    alt: native.alt ?? null,
  };
}

function linkTarget(native: NativePageLink): LinkTarget | null {
  if (native.uri !== undefined) return { kind: 'uri', uri: native.uri };
  const dest = toDestination(native.dest);
  return dest ? { kind: 'internal', dest } : null;
}
