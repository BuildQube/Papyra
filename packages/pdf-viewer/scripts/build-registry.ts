/**
 * Build the papyra registry into the demo's `public/r`, once per component library.
 *
 * `shadcn build` cannot do this alone because a registry item that depends on a
 * *sibling* item has to name it by absolute URL: bare names such as `"button"` always
 * mean official shadcn items, never same-registry ones. So every cross-item edge in
 * `registry.json` carries a `{{REGISTRY}}` placeholder, and this script substitutes
 * the deployed location before handing the file to the CLI.
 *
 * The items are written against Base UI and served from `r/` as before, so every
 * existing install URL keeps meaning what it meant. The Radix flavour is the same
 * files run through `radix.ts` and served from `r/radix/`; its sibling URLs point
 * inside `r/radix/`, so one install never mixes the two. Bare dependencies such as
 * `"collapsible"` need no such care — the consumer's own `style` picks the library.
 *
 * Both flavours are then copied under every shadcn style name, `r/base-nova/`,
 * `r/radix-nova/` and so on, so one namespace URL serves either library:
 * `…/r/{style}/{name}.json`, where the CLI fills `{style}` from the consumer's
 * `components.json`. The value is the whole style, never just `base` or `radix`, and
 * Pages cannot redirect, so it has to be a directory per style. It is the same
 * arrangement shadcn's own registry and ReUI use. A copy's sibling URLs still point
 * at `r/` or `r/radix/`, which is fine: they are the same files.
 *
 * The default is production rather than something derived from `PAPYRA_BASE`. A local
 * build would otherwise emit items pointing at a host that does not serve them, which
 * fails only for whoever installs the artifact — set `PAPYRA_REGISTRY` to override for
 * a fork or a preview deploy.
 *
 * Usage: bun run scripts/build-registry.ts [output-dir]
 *
 * The output defaults to the demo's `public/r`; `check-registry.ts` passes a scratch
 * directory so its localhost URLs never land where a deploy would pick them up.
 */
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import registry from '../registry.json' with { type: 'json' };
import { toRadix } from './radix.js';

const REGISTRY =
  process.env.PAPYRA_REGISTRY ?? 'https://buildqube.github.io/Papyra/r';

const pkg = join(import.meta.dir, '..');
const root = join(pkg, '../..');
const output = process.argv[2] ?? join(pkg, '../../apps/demo/public/r');

/**
 * The style names `{style}` can take, from shadcn 4.19.0's own list
 * (`nova`…`rhea`, each prefixed by its library). `new-york` and `default` predate
 * Base UI support and are Radix. A style missing here is a 404 for that project's
 * install — the honest failure for React Aria (`aria-*`), which has no flavour, and
 * the reason to extend this list when shadcn adds a style.
 */
const STYLES = ['nova', 'vega', 'maia', 'lyra', 'mira', 'luma', 'sera', 'rhea'];
const STYLE_DIRS: Record<string, 'base' | 'radix'> = {
  ...Object.fromEntries(STYLES.map((s) => [`base-${s}`, 'base'])),
  ...Object.fromEntries(STYLES.map((s) => [`radix-${s}`, 'radix'])),
  'new-york': 'radix',
  default: 'radix',
};

/**
 * Build one flavour from the files under `source` into `out`. `source` is the
 * package itself for Base UI and a scratch copy for Radix; the item paths in
 * `registry.json` are relative, so the same file describes both.
 */
async function build(source: string, base: string, out: string) {
  const resolved = JSON.parse(
    JSON.stringify(registry).replaceAll('{{REGISTRY}}', base),
  ) as typeof registry;

  // A placeholder that survives substitution means a typo in the token, which would
  // otherwise ship as a literal URL nobody can fetch.
  const leftover = JSON.stringify(resolved).match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`unsubstituted placeholder: ${leftover[0]}`);

  /** Generated, and gitignored: the checked-in file is the one with the placeholder. */
  const generated = join(source, 'registry.generated.json');
  await writeFile(generated, `${JSON.stringify(resolved, null, 2)}\n`);

  const built = Bun.spawnSync(
    ['bunx', '--bun', 'shadcn@4.19.0', 'build', generated, '--output', out],
    { cwd: source, stdout: 'inherit', stderr: 'inherit' },
  );

  await rm(generated, { force: true });

  if (built.exitCode !== 0) {
    throw new Error(`shadcn build failed with ${built.exitCode}`);
  }

  // The CLI reports success whether or not it wrote anything a consumer can use, so
  // check the edge that actually matters: sibling URLs made it into the output, and
  // into *this* flavour's directory.
  //
  // The expected count comes from the source rather than a literal. Hard-coding it
  // means the guard fails the build every time a panel is added to the sidebar, which
  // trains you to bump the number instead of reading what it is telling you.
  const item = registry.items.find((i) => i.name === 'pdf-sidebar');
  const expected = (item?.registryDependencies ?? []).filter((d) =>
    d.includes('{{REGISTRY}}'),
  ).length;
  const sidebar = await Bun.file(join(out, 'pdf-sidebar.json')).json();
  const siblings = (sidebar.registryDependencies as string[]).filter((d) =>
    d.startsWith(`${base}/`),
  );
  if (siblings.length !== expected) {
    throw new Error(
      `pdf-sidebar should carry ${expected} sibling URLs under ${base}, found ${siblings.length}`,
    );
  }
}

/** Format a rewritten file the way the repo formats its own, through stdin so the
 * scratch path's location (outside the repo, and so ignored by biome) is moot. */
function format(text: string, path: string): string {
  const formatted = Bun.spawnSync(
    ['bunx', 'biome', 'format', `--stdin-file-path=${relative(root, path)}`],
    { cwd: root, stdin: new TextEncoder().encode(text) },
  );
  if (formatted.exitCode !== 0) {
    throw new Error(`biome could not format ${path}:\n${formatted.stderr}`);
  }
  return formatted.stdout.toString();
}

/** Copy every item file into `stage`, rewriting the TypeScript for Radix. */
async function stageRadix(stage: string) {
  const paths = new Set(
    registry.items.flatMap((i) => i.files.map((f) => f.path)),
  );
  for (const path of paths) {
    const from = join(pkg, path);
    const to = join(stage, path);
    const text = await Bun.file(from).text();
    const rewritten = /\.tsx?$/.test(path) ? toRadix(text, path) : text;
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, rewritten === text ? text : format(rewritten, from));
  }
  // The CLI reads the registry's style from here when building.
  await Bun.write(
    join(stage, 'components.json'),
    Bun.file(join(pkg, 'components.json')),
  );
}

// Base UI first: the CLI writes into its output directory, and `r/radix` lives
// inside that one.
await build(pkg, REGISTRY, output);

const stage = await mkdtemp(join(tmpdir(), 'papyra-radix-'));
try {
  await stageRadix(stage);
  await build(stage, `${REGISTRY}/radix`, join(output, 'radix'));
} finally {
  await rm(stage, { recursive: true, force: true });
}

const flavours = {
  base: output,
  radix: join(output, 'radix'),
};
for (const [style, flavour] of Object.entries(STYLE_DIRS)) {
  const from = flavours[flavour];
  const files = (await readdir(from)).filter((f) => f.endsWith('.json'));
  // One item per file plus the index; a short copy means the build above
  // half-failed, and a style serving half the registry fails only for that style.
  if (files.length !== registry.items.length + 1) {
    throw new Error(
      `${from} has ${files.length} files, expected ${registry.items.length + 1}`,
    );
  }
  await rm(join(output, style), { recursive: true, force: true });
  await mkdir(join(output, style));
  for (const file of files) {
    await cp(join(from, file), join(output, style, file));
  }
}

console.log(
  `registry built for ${REGISTRY}/{style} — ${registry.items.length} items, ` +
    `${Object.keys(STYLE_DIRS).length} styles`,
);
