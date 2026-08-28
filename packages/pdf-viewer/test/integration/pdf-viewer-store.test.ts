import { describe, expect, test } from 'bun:test';
import { createPdfViewerStore } from '../../src/lib/pdf-viewer-store.js';

/**
 * In `test/integration`, not `test/unit`: the store imports `@build-qube/papyra` for
 * `open` and `PasswordError`, and that entrypoint loads the native addon at module
 * scope. CI's unit-test job runs with no Rust toolchain and no build.
 *
 * What is under test is the property the whole store design rests on — that a write
 * to one slice leaves the others' references untouched, so `useSyncExternalStore`
 * re-renders only the components reading the slice that changed. Assert it here and a
 * future "simplification" to a single flat object fails loudly rather than quietly
 * costing a re-render of every thumbnail on every page change.
 */
describe('slice identity', () => {
  test('a page change leaves search and document alone', () => {
    const store = createPdfViewerStore();
    const before = store.getState();

    store.actions.setPage(0);
    expect(store.getState()).toBe(before); // no document: clamps to 0, no notify

    store.actions.setMatches([]);
    expect(store.getState().search).toBe(before.search);
  });

  test('a search write leaves page alone, and vice versa', () => {
    const store = createPdfViewerStore();
    const match = { page: 3 } as never;

    store.actions.setActive(match);
    const afterActive = store.getState();
    expect(afterActive.search.active).toBe(match);
    expect(afterActive.document).toBe(null);

    store.actions.setActive(match);
    expect(store.getState()).toBe(afterActive); // idempotent write, no notify
  });

  test('notifies once per accepted write and not at all for a no-op', () => {
    const store = createPdfViewerStore();
    let notifications = 0;
    const stop = store.subscribe(() => {
      notifications++;
    });

    store.actions.setError('boom');
    store.actions.setError('boom');
    store.actions.setError(null);
    stop();
    store.actions.setError('after unsubscribe');

    expect(notifications).toBe(2);
  });

  test('page is clamped to the open document', () => {
    const store = createPdfViewerStore();
    store.actions.setPage(9);
    // Nothing is open, so there is no page 9 to move to.
    expect(store.getState().page).toBe(0);
  });
});
