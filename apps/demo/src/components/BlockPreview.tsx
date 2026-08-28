import { Skeleton } from '@workspace/ui/components/skeleton';
import { type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * Mounts a block only once it has been scrolled to.
 *
 * Every preview is a live viewer over a real document, and the registry page lists
 * enough of them that mounting all at once would start that many render queues
 * before the reader has seen the first. `rootMargin` starts the work slightly early,
 * so scrolling arrives at something already painted rather than at a skeleton.
 *
 * Unmounting on the way out is deliberately *not* done: tearing a viewer down and
 * rebuilding it on every scroll past would throw away its render cache, which is the
 * expensive part.
 */
export function BlockPreview({
  children,
  height = 'h-[26rem]',
}: {
  children: ReactNode;
  height?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);

  return (
    <div
      className={`mt-3 flex ${height} overflow-hidden rounded-md border bg-background`}
      ref={ref}
    >
      {seen ? children : <Skeleton className="m-3 flex-1" />}
    </div>
  );
}
