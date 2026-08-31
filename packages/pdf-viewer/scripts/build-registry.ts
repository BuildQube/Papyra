/**
 * Build the papyra registry into the demo's `public/r`.
 *
 * `shadcn build` cannot do this alone because a registry item that depends on a
 * *sibling* item has to name it by absolute URL: bare names such as `"button"` always
 * mean official shadcn items, never same-registry ones. So every cross-item edge in
 * `registry.json` carries a `{{REGISTRY}}` placeholder, and this script substitutes
 * the deployed location before handing the file to the CLI.
 *
 * The default is production rather than something derived from `PAPYRA_BASE`. A local
 * build would otherwise emit items pointing at a host that does not serve them, which
 * fails only for whoever installs the artifact — set `PAPYRA_REGISTRY` to override for
 * a fork or a preview deploy.
 *
 * Usage: bun run scripts/build-registry.ts
 */
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import registry from '../registry.json' with { type: 'json' };

const REGISTRY =
  process.env.PAPYRA_REGISTRY ?? 'https://buildqube.github.io/Papyra/r';

const pkg = join(import.meta.dir, '..');
/** Generated, and gitignored: the checked-in file is the one with the placeholder. */
const generated = join(pkg, 'registry.generated.json');
const output = join(pkg, '../../apps/demo/public/r');

const resolved = JSON.parse(
  JSON.stringify(registry).replaceAll('{{REGISTRY}}', REGISTRY),
) as typeof registry;

// A placeholder that survives substitution means a typo in the token, which would
// otherwise ship as a literal URL nobody can fetch.
const leftover = JSON.stringify(resolved).match(/\{\{[A-Z_]+\}\}/);
if (leftover) throw new Error(`unsubstituted placeholder: ${leftover[0]}`);

await writeFile(generated, `${JSON.stringify(resolved, null, 2)}\n`);

const built = Bun.spawnSync(
  ['bunx', '--bun', 'shadcn@4.19.0', 'build', generated, '--output', output],
  { cwd: pkg, stdout: 'inherit', stderr: 'inherit' },
);

await rm(generated, { force: true });

if (built.exitCode !== 0) {
  throw new Error(`shadcn build failed with ${built.exitCode}`);
}

// The CLI reports success whether or not it wrote anything a consumer can use, so
// check the edge that actually matters: sibling URLs made it into the output.
//
// The expected count comes from the source rather than a literal. Hard-coding it
// means the guard fails the build every time a panel is added to the sidebar, which
// trains you to bump the number instead of reading what it is telling you.
const source = registry.items.find((i) => i.name === 'pdf-sidebar');
const expected = (source?.registryDependencies ?? []).filter((d) =>
  d.includes('{{REGISTRY}}'),
).length;
const sidebar = await Bun.file(join(output, 'pdf-sidebar.json')).json();
const siblings = (sidebar.registryDependencies as string[]).filter((d) =>
  d.startsWith('http'),
);
if (siblings.length !== expected) {
  throw new Error(
    `pdf-sidebar should carry ${expected} sibling URLs, found ${siblings.length}`,
  );
}

console.log(`registry built for ${REGISTRY} (${registry.items.length} items)`);
