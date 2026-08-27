import { describe, expect, test } from 'bun:test';
import type { PageLink as NativePageLink } from '@build-qube/papyra-native';
import { toPageLink } from '../../src/links.js';
import { scaleRect } from '../../src/text.js';

/** A native link with everything but the fields under test defaulted. */
function native(overrides: Partial<NativePageLink> = {}): NativePageLink {
  return {
    x0: 72,
    y0: 100,
    x1: 200,
    y1: 120,
    dest: undefined,
    uri: undefined,
    alt: undefined,
    ...overrides,
  };
}

const DEST = {
  page: 4,
  kind: 'XYZ',
  left: 72,
  top: 640,
  right: undefined,
  bottom: undefined,
  zoom: undefined,
};

describe('toPageLink', () => {
  test('turns two corners into an x/y/width/height rect', () => {
    // The bindings report corners; a viewer positioning an overlay wants a box.
    const link = toPageLink(native({ dest: DEST }));
    expect(link?.rect).toEqual({ x: 72, y: 100, width: 128, height: 20 });
  });

  test('reports an internal link as a destination', () => {
    const link = toPageLink(native({ dest: DEST }));
    expect(link?.target).toEqual({
      kind: 'internal',
      dest: {
        page: 4,
        kind: 'XYZ',
        left: 72,
        top: 640,
        right: null,
        bottom: null,
        zoom: null,
      },
    });
  });

  test('reports a uri link as a uri', () => {
    const link = toPageLink(native({ uri: 'https://example.com' }));
    expect(link?.target).toEqual({
      kind: 'uri',
      uri: 'https://example.com',
    });
  });

  test('a uri wins over a destination if both somehow arrive', () => {
    // The bindings emit one or the other. If that ever changed, following the URI is
    // the safer read: it is the only one that cannot silently point at the wrong page.
    const link = toPageLink(native({ uri: 'https://example.com', dest: DEST }));
    expect(link?.target.kind).toBe('uri');
  });

  test('drops a link with no target at all', () => {
    expect(toPageLink(native())).toBeNull();
  });

  test('normalises a missing tooltip to null', () => {
    expect(toPageLink(native({ dest: DEST }))?.alt).toBeNull();
    expect(toPageLink(native({ dest: DEST, alt: 'See A101' }))?.alt).toBe(
      'See A101',
    );
  });
});

describe('scaleRect', () => {
  test('scales a 72-DPI rect into a render', () => {
    // 150 DPI is 150/72; a link 72pt from the left lands 150px in.
    const scaled = scaleRect(
      { x: 72, y: 36, width: 128, height: 20 },
      150 / 72,
    );
    expect(scaled.x).toBeCloseTo(150, 10);
    expect(scaled.y).toBeCloseTo(75, 10);
    expect(scaled.width).toBeCloseTo(800 / 3, 10);
    expect(scaled.height).toBeCloseTo(125 / 3, 10);
  });
});
