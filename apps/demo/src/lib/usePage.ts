import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback } from 'react';

/**
 * The current page, from the URL.
 *
 * `?page=` is 1-based because it is user-facing; everything internal is a 0-based
 * index. Lives on the root route so the viewer and the export view inherit it and a
 * link like `/export?page=7&format=jpeg` reproduces exactly what you were looking at.
 *
 * Navigation is `replace`, so clicking through a thumbnail strip does not bury the
 * back button under one history entry per page.
 */
export function usePage(): [number, (index: number) => void] {
  const search = useSearch({ strict: false }) as { page?: number };
  const navigate = useNavigate();

  const index = Math.max(0, (search.page ?? 1) - 1);

  const setIndex = useCallback(
    (next: number) => {
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          page: next + 1,
        }),
        replace: true,
      });
    },
    [navigate],
  );

  return [index, setIndex];
}
