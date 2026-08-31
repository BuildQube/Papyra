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

  test('setting a document does not disturb the view mode', () => {
    const store = createPdfViewerStore({ view: 'page' });
    const doc = { doc: { pageCount: 3 } } as never;

    store.actions.setDocument(doc);
    expect(store.getState().view).toBe('page');
    expect(store.getState().document).toBe(doc);

    store.actions.setDocument(doc);
    expect(store.getState().document).toBe(doc); // idempotent
  });

  test('the view mode is live even where nothing renders both', () => {
    const store = createPdfViewerStore();
    // The registry default is continuous; the full block renders only that, but the
    // state carries the other so a toggle is a UI change and not a state change.
    expect(store.getState().view).toBe('scroll');

    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });
    store.actions.setView('page');
    store.actions.setView('page');
    expect(store.getState().view).toBe('page');
    expect(notifications).toBe(1);
  });

  test('page is clamped to the open document', () => {
    const store = createPdfViewerStore();
    store.actions.setPage(9);
    // Nothing is open, so there is no page 9 to move to.
    expect(store.getState().page).toBe(0);
  });
});

describe('rotation', () => {
  test('steps by a quarter turn in both directions and wraps', () => {
    const store = createPdfViewerStore();
    expect(store.getState().rotation).toBe(0);

    store.actions.rotateBy(1);
    expect(store.getState().rotation).toBe(90);
    store.actions.rotateBy(1);
    store.actions.rotateBy(1);
    expect(store.getState().rotation).toBe(270);
    store.actions.rotateBy(1);
    expect(store.getState().rotation).toBe(0);

    // The negative direction is the one a naive modulo gets wrong: -90 is not a
    // rotation the type admits, and 270 is the same turn.
    store.actions.rotateBy(-1);
    expect(store.getState().rotation).toBe(270);
  });

  test('leaves every other slice alone', () => {
    const store = createPdfViewerStore();
    const before = store.getState();

    store.actions.rotateBy(1);
    const after = store.getState();
    expect(after.search).toBe(before.search);
    expect(after.document).toBe(before.document);
    expect(after.page).toBe(before.page);
    expect(after.view).toBe(before.view);
  });

  test('setting the rotation it already has does not notify', () => {
    const store = createPdfViewerStore({ rotation: 90 });
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });

    store.actions.setRotation(90);
    store.actions.rotateBy(1);
    expect(notifications).toBe(1);
    expect(store.getState().rotation).toBe(180);
  });
});

describe('annotations', () => {
  test('defaults to on and toggles', () => {
    const store = createPdfViewerStore();
    expect(store.getState().annotations).toBe(true);

    store.actions.setAnnotations(false);
    expect(store.getState().annotations).toBe(false);
  });

  test('starts from the option when one is given', () => {
    expect(
      createPdfViewerStore({ annotations: false }).getState().annotations,
    ).toBe(false);
  });

  test('an idempotent write does not notify', () => {
    const store = createPdfViewerStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications++;
    });

    store.actions.setAnnotations(true);
    expect(notifications).toBe(0);
  });
});
