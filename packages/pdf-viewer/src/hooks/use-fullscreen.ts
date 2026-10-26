import { type RefObject, useEffect, useState } from 'react';

/**
 * The takeover half: what the caller puts on the element that fills the window.
 * `dvh`, not `vh`: on a phone the static viewport is taller than what shows while
 * the address bar is up. Padded by the safe-area insets, or under
 * `viewport-fit=cover` (iOS, Android edge-to-edge WebViews) the header draws
 * beneath the status bar; they are 0 without it. Border-box, so the padding comes
 * out of `h-dvh w-screen`. Apply it after any caller `className`, so a caller's
 * height or padding cannot win over it.
 */
export const FULLSCREEN_TAKEOVER =
  'fixed inset-0 z-50 h-dvh w-screen bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]';

/**
 * Full screen, as a takeover of the window plus the Fullscreen API on the *page*.
 *
 * Returns whether it is on and a toggle. The caller applies the takeover half
 * itself — `FULLSCREEN_TAKEOVER` on whatever should fill the window — since only it
 * knows which element that is.
 *
 * Two halves, on purpose. The element going `fixed inset-0` is what gives it the
 * whole window — and is the only half iOS Safari gets, since it allows
 * `requestFullscreen` on nothing but video. Where the API exists it is asked of
 * the document element, not the viewer: a fullscreen element shows only its own
 * subtree, and the find bar, the more menu, the panel picker and the drawer all
 * portal to `body`, so a viewer that went fullscreen by itself would lose every
 * one of them. The page going fullscreen hides the browser chrome and leaves the
 * portals where they are.
 *
 * Escape exits either way: the browser ends the API half itself and this hook
 * hears it, and the takeover half listens for the key where the API is absent.
 * That press is the viewer's when it lands inside `root`. One landing in a popup
 * portaled out of it, such as a menu closing, is the popup's. A host dialog can
 * therefore cancel its own dismissal while `data-fullscreen` is set, and the press
 * still ends full screen: Radix's `onEscapeKeyDown` calling `preventDefault` does
 * not hide it from here.
 *
 * @param root The element that takes over the window.
 */
export function useFullscreen(
  root: RefObject<HTMLElement | null>,
): [boolean, () => void] {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!on) return;
    const exited = () => {
      if (!document.fullscreenElement) setOn(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.fullscreenElement) return;
      const target = event.target;
      // Not `defaultPrevented`: a menu closing and a host dialog refusing to close
      // both set it, and only the first was not meant for this.
      if (target === document.body || root.current?.contains(target as Node)) {
        setOn(false);
      }
    };
    document.addEventListener('fullscreenchange', exited);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', exited);
      document.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) void document.exitFullscreen?.();
    };
  }, [on, root]);

  const toggle = () => {
    if (on) {
      setOn(false);
      return;
    }
    setOn(true);
    // Rejected when the gesture is not trusted or the page forbids it; the
    // takeover half still applies, so a rejection is not an error to show.
    document.documentElement.requestFullscreen?.().catch(() => {});
  };

  return [on, toggle];
}
