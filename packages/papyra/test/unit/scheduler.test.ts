import { describe, expect, test } from 'bun:test';
import { AbortError, Scheduler } from '../../src/scheduler.js';

/** A job whose completion we control, so ordering is deterministic. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Scheduler', () => {
  test('runs the most urgent pending job first', async () => {
    const order: string[] = [];
    const s = new Scheduler<string>(1);
    const block = deferred<string>();

    // Occupy the single slot so the rest queue up.
    s.submit({ key: 'blocker', priority: 0, run: () => block.promise });
    s.submit({
      key: 'c',
      priority: 5,
      run: async () => {
        order.push('c');
        return 'c';
      },
    });
    s.submit({
      key: 'a',
      priority: 1,
      run: async () => {
        order.push('a');
        return 'a';
      },
    });
    s.submit({
      key: 'b',
      priority: 3,
      run: async () => {
        order.push('b');
        return 'b';
      },
    });

    block.resolve('blocker');
    await tick();
    await tick();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  test('equal priorities keep submission order', async () => {
    const order: number[] = [];
    const s = new Scheduler<number>(1);
    const block = deferred<number>();
    s.submit({ key: 'blocker', priority: 0, run: () => block.promise });

    for (const n of [3, 1, 2]) {
      s.submit({
        key: `k${n}`,
        priority: 7,
        run: async () => {
          order.push(n);
          return n;
        },
      });
    }

    block.resolve(0);
    await tick();
    await tick();
    expect(order).toEqual([3, 1, 2]);
  });

  test('never exceeds the concurrency limit', async () => {
    let live = 0;
    let peak = 0;
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    const s = new Scheduler<void>(2);

    for (const [i, gate] of gates.entries()) {
      s.submit({
        key: `k${i}`,
        priority: 0,
        run: async () => {
          live++;
          peak = Math.max(peak, live);
          await gate.promise;
          live--;
        },
      });
    }

    await tick();
    expect(peak).toBe(2);
    for (const g of gates) g.resolve();
    await tick();
    await tick();
    expect(peak).toBe(2);
  });

  test('coalesces duplicate keys into a single run', async () => {
    let runs = 0;
    const s = new Scheduler<string>(2);
    const job = () => ({
      key: 'page-3',
      priority: 0,
      run: async () => {
        runs++;
        return 'done';
      },
    });

    const a = s.submit(job());
    const b = s.submit(job());
    expect(await a.promise).toBe('done');
    expect(await b.promise).toBe('done');
    expect(runs).toBe(1);
  });

  test('a duplicate request promotes queued work rather than duplicating it', async () => {
    const order: string[] = [];
    const s = new Scheduler<string>(1);
    const block = deferred<string>();
    s.submit({ key: 'blocker', priority: 0, run: () => block.promise });

    s.submit({
      key: 'low',
      priority: 9,
      run: async () => {
        order.push('low');
        return 'l';
      },
    });
    s.submit({
      key: 'mid',
      priority: 5,
      run: async () => {
        order.push('mid');
        return 'm';
      },
    });
    // Same page comes into view: urgent now.
    s.submit({
      key: 'low',
      priority: 0,
      run: async () => {
        order.push('low');
        return 'l';
      },
    });

    block.resolve('b');
    await tick();
    await tick();
    expect(order).toEqual(['low', 'mid']);
  });

  test('setPriority reorders pending work', async () => {
    const order: string[] = [];
    const s = new Scheduler<string>(1);
    const block = deferred<string>();
    s.submit({ key: 'blocker', priority: 0, run: () => block.promise });

    s.submit({
      key: 'x',
      priority: 1,
      run: async () => {
        order.push('x');
        return 'x';
      },
    });
    const y = s.submit({
      key: 'y',
      priority: 9,
      run: async () => {
        order.push('y');
        return 'y';
      },
    });
    y.setPriority(0); // scrolled into view

    block.resolve('b');
    await tick();
    await tick();
    expect(order).toEqual(['y', 'x']);
  });

  test('setPriority is a no-op once a job is running', async () => {
    const s = new Scheduler<string>(1);
    const gate = deferred<string>();
    const running = s.submit({
      key: 'r',
      priority: 0,
      run: () => gate.promise,
    });
    await tick();
    expect(s.runningCount).toBe(1);
    running.setPriority(99); // must not throw or requeue
    gate.resolve('ok');
    expect(await running.promise).toBe('ok');
  });

  test('cancelling pending work drops it and rejects', async () => {
    let ran = false;
    const s = new Scheduler<string>(1);
    const block = deferred<string>();
    s.submit({ key: 'blocker', priority: 0, run: () => block.promise });

    const doomed = s.submit({
      key: 'doomed',
      priority: 1,
      run: async () => {
        ran = true;
        return 'nope';
      },
    });
    // Attach the handler before cancelling: cancel rejects synchronously, and an
    // unheld rejection is an unhandled rejection.
    let caught: unknown;
    doomed.promise.catch((e) => {
      caught = e;
    });
    doomed.cancel('scrolled away');
    expect(s.pendingCount).toBe(0);

    block.resolve('b');
    await tick();
    await tick();
    expect(ran).toBe(false);
    expect(caught).toBeInstanceOf(AbortError);
    expect((caught as AbortError).message).toBe('scrolled away');
  });

  test('a shared job survives until every waiter detaches', async () => {
    let ran = false;
    const s = new Scheduler<string>(1);
    const block = deferred<string>();
    s.submit({ key: 'blocker', priority: 0, run: () => block.promise });

    const spec = {
      key: 'shared',
      priority: 1,
      run: async () => {
        ran = true;
        return 'ok';
      },
    };
    const a = s.submit(spec);
    const b = s.submit(spec);

    // Detaching one waiter must not reject the promise the other is holding.
    a.cancel();
    expect(s.pendingCount).toBe(1); // b still wants it

    block.resolve('b');
    await tick();
    await tick();
    expect(ran).toBe(true);
    expect(await b.promise).toBe('ok');
  });

  test('cancelling a running job leaves it to finish', async () => {
    const s = new Scheduler<string>(1);
    const gate = deferred<string>();
    const handle = s.submit({ key: 'r', priority: 0, run: () => gate.promise });
    await tick();
    handle.cancel('too late');
    gate.resolve('finished anyway');
    expect(await handle.promise).toBe('finished anyway');
  });

  test('failures reach every waiter and free the slot', async () => {
    const s = new Scheduler<string>(1);
    const boom = new Error('render failed');
    const a = s.submit({
      key: 'bad',
      priority: 0,
      run: () => Promise.reject(boom),
    });
    const b = s.submit({
      key: 'bad',
      priority: 0,
      run: () => Promise.reject(boom),
    });

    await expect(a.promise).rejects.toThrow('render failed');
    await expect(b.promise).rejects.toThrow('render failed');

    const after = s.submit({ key: 'good', priority: 0, run: async () => 'ok' });
    expect(await after.promise).toBe('ok');
  });
});

describe('Scheduler timing', () => {
  test('separates queue wait from run time', async () => {
    const s = new Scheduler<string>(1);
    const block = deferred<string>();
    const blocker = s.submit({
      key: 'blocker',
      priority: 0,
      run: () => block.promise,
    });

    const waiting = s.submit({
      key: 'waiting',
      priority: 0,
      run: () => new Promise<string>((r) => setTimeout(() => r('done'), 30)),
    });
    expect(waiting.timing).toBeNull();

    await new Promise((r) => setTimeout(r, 40));
    block.resolve('unblocked');
    await blocker.promise;
    await waiting.promise;

    const t = waiting.timing;
    expect(t).not.toBeNull();
    // Queued behind the blocker for ~40ms, then ran for ~30ms.
    expect(t?.waitMs).toBeGreaterThan(20);
    expect(t?.runMs).toBeGreaterThan(20);
    expect(t?.runMs).toBeLessThan(t?.waitMs ?? 0 + 1000);
  });

  test('a job that starts immediately reports near-zero wait', async () => {
    const s = new Scheduler<string>(2);
    const h = s.submit({ key: 'a', priority: 0, run: async () => 'x' });
    await h.promise;
    expect(h.timing?.waitMs).toBeLessThan(5);
  });

  test('oldestWaitMs tracks the longest-queued pending job', async () => {
    const s = new Scheduler<string>(1);
    const block = deferred<string>();
    s.submit({ key: 'blocker', priority: 0, run: () => block.promise });
    s.submit({ key: 'q', priority: 0, run: async () => 'x' });

    expect(s.oldestWaitMs).toBeLessThan(5);
    await new Promise((r) => setTimeout(r, 25));
    expect(s.oldestWaitMs).toBeGreaterThan(20);

    block.resolve('b');
    await new Promise((r) => setTimeout(r, 10));
    expect(s.oldestWaitMs).toBe(0); // nothing pending
  });
});

describe('Scheduler yieldToUrgent', () => {
  test('holds back lower-priority work while urgent work runs', async () => {
    const s = new Scheduler<string>(4);
    const urgent = deferred<string>();
    let lowStarted = 0;

    s.submit({ key: 'urgent', priority: 0, run: () => urgent.promise });
    for (let i = 0; i < 3; i++) {
      s.submit({
        key: `low${i}`,
        priority: 5,
        run: async () => {
          lowStarted++;
          return 'low';
        },
      });
    }

    await tick();
    // Slots are free, but starting them would steal CPU from the urgent render.
    expect(lowStarted).toBe(0);

    urgent.resolve('done');
    await tick();
    await tick();
    expect(lowStarted).toBe(3);
  });

  test('does nothing when every job shares a priority', async () => {
    let live = 0;
    let peak = 0;
    const gates = Array.from({ length: 4 }, () => deferred<void>());
    const s = new Scheduler<void>(4);

    for (const [i, gate] of gates.entries()) {
      s.submit({
        key: `k${i}`,
        priority: 3,
        run: async () => {
          live++;
          peak = Math.max(peak, live);
          await gate.promise;
          live--;
        },
      });
    }
    await tick();
    expect(peak).toBe(4); // batch throughput is untouched
    for (const g of gates) g.resolve();
    await tick();
  });

  test('can be turned off', async () => {
    const s = new Scheduler<string>(4, { yieldToUrgent: false });
    const urgent = deferred<string>();
    let lowStarted = 0;

    s.submit({ key: 'urgent', priority: 0, run: () => urgent.promise });
    s.submit({
      key: 'low',
      priority: 5,
      run: async () => {
        lowStarted++;
        return 'low';
      },
    });

    await tick();
    expect(lowStarted).toBe(1);
    urgent.resolve('done');
    await tick();
  });
});
