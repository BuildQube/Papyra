/**
 * Priority-ordered render scheduler.
 *
 * papyra does not decide what is urgent — the caller does. A viewer knows which pages
 * are on screen, which are one scroll away, and which are thumbnails nobody is looking
 * at; the library does not. Callers attach a priority and this queue honours it.
 *
 * Pending work is reordered freely. Work already running is never interrupted: a page
 * render is dominated by a fixed, non-preemptible content-stream interpretation cost
 * (~95ms of a ~150ms render on a large drawing, independent of output size — see
 * docs/spike-results.md), so cancelling mid-render would reclaim only the rasterisation
 * tail. Reordering what has not started yet captures nearly all of the benefit.
 */

/** Runs first. Lower is more urgent; the default is the most urgent tier. */
export const DEFAULT_PRIORITY = 0;

export interface SchedulerJob<T> {
  /** Identity for coalescing. Two live requests with the same key share one render. */
  key: string;
  priority: number;
  run: () => Promise<T>;
}

export interface JobHandle<T> {
  readonly key: string;
  /** Reassign urgency while the job is still pending. A no-op once it is running. */
  setPriority(priority: number): void;
  readonly promise: Promise<T>;
  /**
   * Detach from this job. If nothing else is waiting on it and it has not started,
   * it is dropped from the queue; if it is already running it is left to finish.
   */
  cancel(reason?: string): void;
}

interface Entry<T> {
  key: string;
  priority: number;
  /** Insertion order, so equal priorities stay FIFO. */
  seq: number;
  run: () => Promise<T>;
  waiters: number;
  started: boolean;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  promise: Promise<T>;
}

export class AbortError extends Error {
  override readonly name = 'AbortError';
  constructor(reason = 'cancelled') {
    super(reason);
  }
}

export class Scheduler<T> {
  readonly #limit: number;
  readonly #pending = new Map<string, Entry<T>>();
  readonly #running = new Map<string, Entry<T>>();
  #seq = 0;

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get runningCount(): number {
    return this.#running.size;
  }

  submit(job: SchedulerJob<T>): JobHandle<T> {
    const existing = this.#pending.get(job.key) ?? this.#running.get(job.key);
    if (existing) {
      existing.waiters++;
      // A more urgent request for work already queued promotes it rather than
      // duplicating it — the common case when a thumbnail scrolls into view.
      if (job.priority < existing.priority) existing.priority = job.priority;
      return this.#handle(existing);
    }

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry: Entry<T> = {
      key: job.key,
      priority: job.priority,
      seq: this.#seq++,
      run: job.run,
      waiters: 1,
      started: false,
      resolve,
      reject,
      promise,
    };
    this.#pending.set(entry.key, entry);
    this.#drain();
    return this.#handle(entry);
  }

  #handle(entry: Entry<T>): JobHandle<T> {
    let detached = false;
    return {
      key: entry.key,
      promise: entry.promise,
      setPriority: (priority: number) => {
        if (!entry.started) entry.priority = priority;
      },
      cancel: (reason?: string) => {
        if (detached) return;
        detached = true;
        entry.waiters--;
        if (entry.waiters > 0 || entry.started) return;
        this.#pending.delete(entry.key);
        entry.reject(new AbortError(reason));
      },
    };
  }

  /**
   * Start whatever fits, most urgent first.
   *
   * A linear scan rather than a heap: queues are page-sized (hundreds at most) and
   * each job costs milliseconds, so the scan is free — and mutable priorities in a
   * binary heap need re-heapification on every change, which is a rich source of bugs.
   */
  #drain(): void {
    while (this.#running.size < this.#limit && this.#pending.size > 0) {
      let next: Entry<T> | undefined;
      for (const entry of this.#pending.values()) {
        if (
          !next ||
          entry.priority < next.priority ||
          (entry.priority === next.priority && entry.seq < next.seq)
        ) {
          next = entry;
        }
      }
      if (!next) return;

      this.#pending.delete(next.key);
      this.#running.set(next.key, next);
      next.started = true;

      next
        .run()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.#running.delete(next.key);
          this.#drain();
        });
    }
  }
}
