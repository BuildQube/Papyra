import { describe, expect, test } from 'bun:test';
import { RenderCache } from '../../src/cache.js';

/** Stand-in for a rendered page: the number is its size in bytes. */
const sizeOf = (n: number) => n;

describe('RenderCache', () => {
  test('returns what it stored, and counts hits and misses', () => {
    const c = new RenderCache<number>(1000, sizeOf);
    expect(c.get('a')).toBeUndefined();
    c.set('a', 100);
    expect(c.get('a')).toBe(100);
    expect(c.stats).toMatchObject({
      hits: 1,
      misses: 1,
      entries: 1,
      bytes: 100,
    });
  });

  test('evicts least-recently-used first', () => {
    const c = new RenderCache<number>(300, sizeOf);
    c.set('a', 100);
    c.set('b', 100);
    c.set('c', 100);

    c.get('a'); // 'a' is now most recent, so 'b' is the oldest
    c.set('d', 100);

    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(100);
    expect(c.get('c')).toBe(100);
    expect(c.get('d')).toBe(100);
    expect(c.stats.evictions).toBe(1);
  });

  test('bounds by bytes, not entry count', () => {
    const c = new RenderCache<number>(1000, sizeOf);
    // One big page evicts many small thumbnails.
    for (let i = 0; i < 10; i++) c.set(`thumb${i}`, 50);
    expect(c.stats.entries).toBe(10);
    expect(c.stats.bytes).toBe(500);

    c.set('page', 800);
    expect(c.stats.bytes).toBeLessThanOrEqual(1000);
    expect(c.get('page')).toBe(800);
    // Only as many thumbnails as still fit alongside it.
    expect(c.stats.entries).toBeLessThan(11);
  });

  test('refuses an item larger than the whole budget rather than emptying itself', () => {
    const c = new RenderCache<number>(1000, sizeOf);
    c.set('keep', 500);
    c.set('huge', 5000);

    expect(c.get('huge')).toBeUndefined();
    expect(c.get('keep')).toBe(500); // survivor, not collateral damage
    expect(c.stats.bytes).toBe(500);
  });

  test('replacing a key accounts for the old size', () => {
    const c = new RenderCache<number>(1000, sizeOf);
    c.set('a', 100);
    c.set('a', 300);
    expect(c.stats.entries).toBe(1);
    expect(c.stats.bytes).toBe(300);
  });

  test('a zero budget disables it entirely', () => {
    const c = new RenderCache<number>(0, sizeOf);
    expect(c.enabled).toBe(false);
    c.set('a', 1);
    expect(c.get('a')).toBeUndefined();
    expect(c.stats.bytes).toBe(0);
  });

  test('clear empties it but keeps counters', () => {
    const c = new RenderCache<number>(1000, sizeOf);
    c.set('a', 100);
    c.get('a');
    c.clear();
    expect(c.stats).toMatchObject({ entries: 0, bytes: 0, hits: 1 });
  });
});
