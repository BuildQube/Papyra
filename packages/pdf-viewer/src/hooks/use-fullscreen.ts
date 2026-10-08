import { useEffect, useState } from 'react';

/**
 * Full screen, as a takeover of the window plus the Fullscreen API on the *page*.
 *
 * Returns whether it is on and a toggle. The caller applies the takeover half
 * itself — `fixed inset-0 z-50` on whatever should fill the window — since only it
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
 */
export function useFullscreen(): [boolean, () => void] {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (!on) return;
    const exited = () => {
      if (!document.fullscreenElement) setOn(false);
    };
    const onKey = (event: KeyboardEvent) => {
      // A menu or popover closing on Escape claims the event first; that press
      // was for it, not for this.
      if (event.defaultPrevented || event.key !== 'Escape') return;
      if (!document.fullscreenElement) setOn(false);
    };
    document.addEventListener('fullscreenchange', exited);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', exited);
      document.removeEventListener('keydown', onKey);
      if (document.fullscreenElement) void document.exitFullscreen?.();
    };
  }, [on]);

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
