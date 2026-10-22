import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const NATIVE = '@build-qube/papyra-native';
const OFFICE_NATIVE = '@build-qube/papyra-office-native';
const SRC = resolve(import.meta.dir, '../../src');

/**
 * Specifiers a module loads when it is evaluated, and those it may load later.
 *
 * `import type` and `export type` are erased; every other static form is kept —
 * including `import { type A } from`, which `verbatimModuleSyntax` emits as a
 * side-effect import of the whole module. `import()` is lazy: a bundler splits it
 * into its own chunk, fetched only when the call runs.
 */
function imports(source: string): { eager: string[]; lazy: string[] } {
  const eager: string[] = [];
  const statement =
    /^\s*(?:import|export)\s+(type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s+from\s+'([^']+)'/gm;
  for (const [, typeOnly, spec] of source.matchAll(statement)) {
    if (!typeOnly && spec) eager.push(spec);
  }
  for (const [, spec] of source.matchAll(/^\s*import\s+'([^']+)'/gm)) {
    if (spec) eager.push(spec);
  }
  const lazy = [...source.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)].map(
    ([, spec]) => spec ?? '',
  );
  return { eager, lazy };
}

/**
 * Every file evaluated when `entry` is imported, the packages they load, and the
 * packages left for an `import()` to fetch.
 */
function graph(entry: string): {
  files: Set<string>;
  packages: Set<string>;
  lazy: Set<string>;
} {
  const files = new Set<string>();
  const packages = new Set<string>();
  const lazy = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file; file = pending.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    const found = imports(readFileSync(file, 'utf8'));
    for (const spec of found.eager) {
      if (spec.startsWith('.')) {
        pending.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      } else {
        packages.add(spec);
      }
    }
    for (const spec of found.lazy) lazy.add(spec);
  }
  return { files, packages, lazy };
}

describe('@build-qube/papyra/core', () => {
  test('never loads the native package', () => {
    // The whole point of the entry: importing it must not fetch or start the wasm.
    const { packages } = graph(`${SRC}/core.ts`);
    expect([...packages]).not.toContain(NATIVE);
    expect([...packages]).not.toContain(OFFICE_NATIVE);
  });

  test('does not reach the native package even through import()', () => {
    // A bundler emits the wasm once its graph reaches the loader, lazily or not, so
    // an app whose viewer runs on another engine would ship it all the same.
    const { lazy } = graph(`${SRC}/core.ts`);
    expect([...lazy]).not.toContain(NATIVE);
    expect([...lazy]).not.toContain(OFFICE_NATIVE);
  });

  test('/engine reaches the native package, and only through import()', () => {
    const engine = graph(`${SRC}/papyra-engine.ts`);
    expect([...engine.packages]).not.toContain(NATIVE);
    expect([...engine.lazy]).toContain(NATIVE);
  });

  test('the main entry and /engine never reach the office addon', () => {
    // It is its own wasm module, about 5.7 MB gzipped: only /office may name it.
    for (const entry of ['index.ts', 'papyra-engine.ts']) {
      const { packages, lazy } = graph(`${SRC}/${entry}`);
      expect([...packages, ...lazy]).not.toContain(OFFICE_NATIVE);
    }
  });

  test('/office reaches the office addon only through import()', () => {
    const office = graph(`${SRC}/office.ts`);
    expect([...office.packages]).not.toContain(OFFICE_NATIVE);
    expect([...office.lazy]).toContain(OFFICE_NATIVE);
    expect([...office.packages, ...office.lazy]).not.toContain(NATIVE);
  });

  test('the check can fail', () => {
    // Without this the test above would pass on a walker that found nothing.
    expect([...graph(`${SRC}/index.ts`).packages]).toContain(NATIVE);
    expect(graph(`${SRC}/core.ts`).files.size).toBeGreaterThan(10);
  });

  test('counts an inline type specifier as an eager import', () => {
    const source = [
      "import type { A } from 'erased-a';",
      "export type { B } from 'erased-b';",
      "import { type C } from 'kept-c';",
      "export * from 'kept-d';",
      "const e = await import('kept-e');",
    ].join('\n');
    expect(imports(source)).toEqual({
      eager: ['kept-c', 'kept-d'],
      lazy: ['kept-e'],
    });
  });
});
