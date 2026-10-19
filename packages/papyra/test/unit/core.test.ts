import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const NATIVE = '@build-qube/papyra-native';
const SRC = resolve(import.meta.dir, '../../src');

/**
 * Specifiers a module loads at runtime. `import type` and `export type` are erased;
 * everything else is kept — including `import { type A } from`, which
 * `verbatimModuleSyntax` emits as a side-effect import of the whole module.
 */
function runtimeImports(source: string): string[] {
  const found: string[] = [];
  const statement =
    /^\s*(?:import|export)\s+(type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s+from\s+'([^']+)'/gm;
  for (const [, typeOnly, spec] of source.matchAll(statement)) {
    if (!typeOnly && spec) found.push(spec);
  }
  for (const [, spec] of source.matchAll(/import\s*\(\s*'([^']+)'\s*\)/g)) {
    if (spec) found.push(spec);
  }
  for (const [, spec] of source.matchAll(/^\s*import\s+'([^']+)'/gm)) {
    if (spec) found.push(spec);
  }
  return found;
}

/** Every file reached at runtime from `entry`, and the package specifiers they load. */
function graph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file; file = pending.pop()) {
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of runtimeImports(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        pending.push(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      } else {
        packages.add(spec);
      }
    }
  }
  return { files, packages };
}

describe('@build-qube/papyra/core', () => {
  test('never loads the native package', () => {
    // The whole point of the entry: importing it must not fetch or start the wasm.
    expect([...graph(`${SRC}/core.ts`).packages]).not.toContain(NATIVE);
  });

  test('the check can fail', () => {
    // Without this the test above would pass on a walker that found nothing.
    expect([...graph(`${SRC}/index.ts`).packages]).toContain(NATIVE);
    expect(graph(`${SRC}/core.ts`).files.size).toBeGreaterThan(10);
  });

  test('counts an inline type specifier as a runtime import', () => {
    const source = [
      "import type { A } from 'erased-a';",
      "export type { B } from 'erased-b';",
      "import { type C } from 'kept-c';",
      "export * from 'kept-d';",
      "const e = await import('kept-e');",
    ].join('\n');
    expect(runtimeImports(source)).toEqual(['kept-c', 'kept-d', 'kept-e']);
  });
});
