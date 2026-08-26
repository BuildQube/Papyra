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

/** Where a job's wall-clock time actually went. */
export interface JobTiming {
  /** Submitted until a slot freed and it started. */
  waitMs: number;
  /** Started until it finished. */
  runMs: number;
}

export interface JobHandle<T> {
  readonly key: string;
  /**
   * Populated once the job settles, `null` before that.
   *
   * The point is to tell a slow render from a long queue: if `waitMs` dominates the
   * pool is too busy or the priority is wrong, and if `runMs` dominates the render
   * itself is the cost. Guessing between those two is how you optimise the wrong half.
   */
  readonly timing: JobTiming | null;
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
  queuedAt: number;
  startedAt: number;
  finishedAt: number;
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

export interface SchedulerOptions {
  /**
   * Hold back lower-priority work while something more urgent is still running.
   *
   * Ordering the queue is not enough on its own: once a job starts it competes for CPU
   * for its whole duration, so a page rendered alongside three thumbnails takes ~4x as
   * long as one rendered alone. With this on, a job only starts if nothing strictly
   * more urgent is running — already-running work is left to finish, never preempted.
   *
   * It is a no-op when every job shares a priority, so batch throughput is unaffected
   * and it only engages once a caller has expressed intent. On by default.
   */
  yieldToUrgent?: boolean;
}

/**
 * One queue for every kind of work a document does.
 *
 * Deliberately not parameterised by payload: renders and text extraction compete for
 * the same cores, so they have to share a queue for priority to mean anything. Entries
 * are stored opaquely and `submit` recovers the type — sound because coalescing is by
 * key, and two jobs with the same key are by construction the same job.
 */
export class Scheduler {
  readonly #limit: number;
  readonly #yieldToUrgent: boolean;
  readonly #pending = new Map<string, Entry<unknown>>();
  readonly #running = new Map<string, Entry<unknown>>();
  #seq = 0;

  constructor(limit: number, options: SchedulerOptions = {}) {
    this.#limit = Math.max(1, limit);
    this.#yieldToUrgent = options.yieldToUrgent ?? true;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  get runningCount(): number {
    return this.#running.size;
  }

  #hasMoreUrgentRunning(priority: number): boolean {
    for (const entry of this.#running.values()) {
      if (entry.priority < priority) return true;
    }
    return false;
  }

  /** How long the longest-waiting pending job has been queued. */
  get oldestWaitMs(): number {
    let oldest = 0;
    const now = performance.now();
    for (const entry of this.#pending.values()) {
      oldest = Math.max(oldest, now - entry.queuedAt);
    }
    return oldest;
  }

  submit<T>(job: SchedulerJob<T>): JobHandle<T> {
    const existing = this.#pending.get(job.key) ?? this.#running.get(job.key);
    if (existing) {
      existing.waiters++;
      // A more urgent request for work already queued promotes it rather than
      // duplicating it — the common case when a thumbnail scrolls into view.
      if (job.priority < existing.priority) existing.priority = job.priority;
      return this.#handle(existing) as JobHandle<T>;
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
      queuedAt: performance.now(),
      startedAt: 0,
      finishedAt: 0,
      seq: this.#seq++,
      run: job.run,
      waiters: 1,
      started: false,
      resolve,
      reject,
      promise,
    };
    this.#pending.set(entry.key, entry as Entry<unknown>);
    this.#drain();
    return this.#handle(entry as Entry<unknown>) as JobHandle<T>;
  }

  #handle(entry: Entry<unknown>): JobHandle<unknown> {
    let detached = false;
    return {
      key: entry.key,
      promise: entry.promise,
      get timing() {
        return entry.finishedAt
          ? {
              waitMs: entry.startedAt - entry.queuedAt,
              runMs: entry.finishedAt - entry.startedAt,
            }
          : null;
      },
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
      let next: Entry<unknown> | undefined;
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

      // Do not pile lower-priority work on top of something more urgent that is
      // already running; it would only steal CPU from it.
      if (this.#yieldToUrgent && this.#hasMoreUrgentRunning(next.priority))
        return;

      this.#pending.delete(next.key);
      this.#running.set(next.key, next);
      next.started = true;
      next.startedAt = performance.now();

      // Stamp the finish time before settling, so `timing` is already populated by
      // the time an awaiting caller resumes — a `.finally()` would run after them.
      next
        .run()
        .then(
          (value) => {
            next.finishedAt = performance.now();
            next.resolve(value);
          },
          (error) => {
            next.finishedAt = performance.now();
            next.reject(error);
          },
        )
        .finally(() => {
          this.#running.delete(next.key);
          this.#drain();
        });
    }
  }
}
