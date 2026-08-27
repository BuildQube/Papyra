/**
 * Size-bounded LRU for rendered pages.
 *
 * Worth having because a render is never cheap: on a large CAD drawing every page costs
 * >=93ms no matter how small the output, since the cost is per-draw-call rather than
 * per-pixel (see docs/spike-results.md). A viewer re-renders the same page constantly —
 * scrolling back, returning from a zoom, promoting a thumbnail — and each of those is a
 * fresh 93ms without a cache.
 *
 * Bounded by **bytes**, not entries, because page bitmaps span three orders of
 * magnitude: a 160px thumbnail of an ARCH-E sheet is 0.07 MB and the same page at
 * 2000px is 11.4 MB. An entry-count limit would either hold almost nothing or hundreds
 * of megabytes depending on the document.
 */

export interface CacheStats {
  /** Bytes currently held. */
  bytes: number;
  /** Pages currently held. */
  entries: number;
  /** Lookups served without rendering. */
  hits: number;
  /** Lookups that had to render. */
  misses: number;
  /** Entries dropped to stay under budget. */
  evictions: number;
}

export class RenderCache<T> {
  readonly #budget: number;
  readonly #sizeOf: (value: T) => number;
  /** Insertion order is the LRU order: re-inserting on read moves an entry to the end. */
  readonly #entries = new Map<string, T>();
  #bytes = 0;
  #hits = 0;
  #misses = 0;
  #evictions = 0;

  constructor(budgetBytes: number, sizeOf: (value: T) => number) {
    this.#budget = Math.max(0, budgetBytes);
    this.#sizeOf = sizeOf;
  }

  get enabled(): boolean {
    return this.#budget > 0;
  }

  get(key: string): T | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) {
      this.#misses++;
      return undefined;
    }
    // Move to the most-recently-used end.
    this.#entries.delete(key);
    this.#entries.set(key, value);
    this.#hits++;
    return value;
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;
    const size = this.#sizeOf(value);
    // An item larger than the whole budget would evict everything and still not fit.
    if (size > this.#budget) return;

    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      this.#bytes -= this.#sizeOf(existing);
      this.#entries.delete(key);
    }
    this.#entries.set(key, value);
    this.#bytes += size;
    this.#evict();
  }

  #evict(): void {
    while (this.#bytes > this.#budget) {
      // Map iteration starts at the least-recently-used entry.
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      const value = this.#entries.get(oldest.value);
      if (value !== undefined) this.#bytes -= this.#sizeOf(value);
      this.#entries.delete(oldest.value);
      this.#evictions++;
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }

  get stats(): CacheStats {
    return {
      bytes: this.#bytes,
      entries: this.#entries.size,
      hits: this.#hits,
      misses: this.#misses,
      evictions: this.#evictions,
    };
  }
}
