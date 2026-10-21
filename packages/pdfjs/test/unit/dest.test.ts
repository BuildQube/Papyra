import { describe, expect, test } from 'bun:test';
import { toDestination } from '../../src/dest.js';

const ref = { num: 12, gen: 0 };
const pageOf = async (r: unknown) => (r === ref ? 4 : Promise.reject());

describe('toDestination', () => {
  test('XYZ names its arguments and reads a zoom of 0 as unchanged', async () => {
    expect(
      await toDestination([ref, { name: 'XYZ' }, 10, 700, 0], pageOf),
    ).toEqual({
      page: 4,
      kind: 'XYZ',
      left: 10,
      top: 700,
      right: null,
      bottom: null,
      zoom: null,
    });
  });

  test('FitR is left, bottom, right, top, as the spec orders them', async () => {
    const dest = await toDestination(
      [ref, { name: 'FitR' }, 1, 2, 3, 4],
      pageOf,
    );
    expect(dest).toMatchObject({ left: 1, bottom: 2, right: 3, top: 4 });
  });

  test('a bare page number is taken as the index', async () => {
    const dest = await toDestination([2, { name: 'Fit' }], pageOf);
    expect(dest?.page).toBe(2);
  });

  test('a null argument stays null', async () => {
    const dest = await toDestination([ref, { name: 'FitH' }, null], pageOf);
    expect(dest?.top).toBeNull();
  });

  test('unresolvable or unknown destinations are null', async () => {
    expect(await toDestination(null, pageOf)).toBeNull();
    expect(await toDestination([{}, { name: 'Fit' }], pageOf)).toBeNull();
    expect(await toDestination([ref, { name: 'Nope' }], pageOf)).toBeNull();
  });
});
