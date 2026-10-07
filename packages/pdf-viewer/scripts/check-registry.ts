/**
 * Install every registry item into a fresh shadcn project per component library and
 * typecheck the result.
 *
 * This is the only check that sees what a consumer sees. The registry is built with
 * its URLs pointing at a local server, `shadcn init` makes a project of each
 * library, the `@papyra` namespace is registered with its `{style}` URL, and
 * `shadcn add @papyra/…` installs every item — pulling the official primitives
 * for *that* library — before `tsc` runs over the lot. An item written against an API
 * the other library lacks installs without complaint and fails only here, which is
 * how the Radix flavour would otherwise drift: nothing in this repo compiles it.
 *
 * The fixture's `@build-qube/papyra` is linked to this workspace, so the check is
 * about the items and the code beside them, not about what npm has published.
 * `--published` keeps npm's copy instead, which is what tells you an item's version
 * range has fallen behind the APIs it calls.
 *
 * Needs the network (npm, and ui.shadcn.com for the primitives) and a built
 * `packages/papyra`.
 *
 * Usage: bun run scripts/check-registry.ts [--only base|radix|new-york] [--published] [--keep]
 */
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import registry from '../registry.json' with { type: 'json' };

const SHADCN = 'shadcn@4.19.0';

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    published: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});

/**
 * Each fixture: the `shadcn init -b` library, an optional `style` to write over the
 * one init chose, and the directory the CLI must then ask for. `new-york` is there
 * because the CLI rewrites it to `new-york-v4` in a Tailwind v4 project before
 * filling `{style}` — a fresh `-b` project never takes that path, and the registry
 * shipped without the directory it needs.
 */
const FLAVOURS = [
  { name: 'base', base: 'base', expect: 'base-nova' },
  { name: 'radix', base: 'radix', expect: 'radix-nova' },
  {
    name: 'new-york',
    base: 'radix',
    style: 'new-york',
    expect: 'new-york-v4',
  },
].filter((f) => !args.only || f.name === args.only);
if (FLAVOURS.length === 0) throw new Error(`unknown flavour: ${args.only}`);

const pkg = join(import.meta.dir, '..');
const papyra = join(pkg, '../papyra');
if (
  !args.published &&
  !(await Bun.file(join(papyra, 'dist/index.d.ts')).exists())
) {
  throw new Error('packages/papyra is not built: run `bun run build` first');
}

const scratch = await mkdtemp(join(tmpdir(), 'papyra-registry-check-'));
const served = join(scratch, 'r');
/** The first path segment under `r/` of every request, i.e. the `{style}` asked for. */
const requested = new Set<string>();
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const style = path.split('/')[2];
    if (style) requested.add(style);
    const file = Bun.file(join(scratch, path));
    return (await file.exists())
      ? new Response(file)
      : new Response('not found', { status: 404 });
  },
});
const registryUrl = `http://localhost:${server.port}/r`;

function run(cmd: string[], cwd: string, env?: Record<string, string>) {
  console.log(`$ ${cmd.join(' ')}`);
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exited;
}

const failed: string[] = [];
try {
  const built = await run(
    ['bun', 'run', 'scripts/build-registry.ts', served],
    pkg,
    { PAPYRA_REGISTRY: registryUrl },
  );
  if (built !== 0) throw new Error('registry build failed');

  for (const { name, base, style, expect } of FLAVOURS) {
    const dir = join(scratch, name);
    const fixture = join(dir, 'fixture');
    await Bun.$`mkdir -p ${dir}`;

    const init = await run(
      [
        'bunx',
        '--bun',
        SHADCN,
        'init',
        '-t',
        'vite',
        '-b',
        base,
        '-p',
        'nova',
        '-n',
        'fixture',
        '-y',
        '--no-monorepo',
      ],
      dir,
    );
    if (init !== 0) throw new Error(`shadcn init failed for ${name}`);

    if (style) {
      const path = join(fixture, 'components.json');
      const config = await Bun.file(path).json();
      await Bun.write(
        path,
        `${JSON.stringify({ ...config, style }, null, 2)}\n`,
      );
    }

    // The way the docs tell people to install: one namespace whose `{style}` the
    // CLI fills from this project's components.json. That is what routes a Radix
    // project to the Radix files, so it is the path worth testing, not the
    // flavour's own directory.
    const setup = await run(
      [
        'bunx',
        '--bun',
        SHADCN,
        'registry',
        'add',
        `@papyra=${registryUrl}/{style}/{name}.json`,
      ],
      fixture,
    );
    if (setup !== 0) throw new Error(`shadcn registry add failed for ${name}`);

    requested.clear();
    const items = registry.items.map((i) => `@papyra/${i.name}`);
    const add = await run(
      ['bunx', '--bun', SHADCN, 'add', '-y', '-o', ...items],
      fixture,
    );
    if (add !== 0) {
      failed.push(`${name}: shadcn add`);
      continue;
    }
    // A wrong directory can still typecheck, when two styles share a flavour, so
    // check the routing itself rather than only its result.
    if (!requested.has(expect)) {
      failed.push(
        `${name}: expected requests under r/${expect}/, saw ${[...requested].join(', ')}`,
      );
      continue;
    }

    if (!args.published) {
      const linked = join(fixture, 'node_modules/@build-qube/papyra');
      await rm(linked, { recursive: true, force: true });
      await symlink(papyra, linked, 'dir');
    }

    const tsc = await run(
      ['bunx', 'tsc', '-p', 'tsconfig.app.json', '--noEmit'],
      fixture,
    );
    if (tsc !== 0) failed.push(`${name}: tsc`);
    else
      console.log(
        `✔ ${name}: ${items.length} items install from r/${expect}/ and typecheck`,
      );
  }
} finally {
  server.stop(true);
  if (args.keep) console.log(`fixtures kept in ${scratch}`);
  else await rm(scratch, { recursive: true, force: true });
}

if (failed.length > 0) {
  console.error(`registry check failed:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
