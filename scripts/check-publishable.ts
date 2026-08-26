/**
 * Refuse to publish a manifest npm cannot install.
 *
 * `workspace:*` is a pnpm/yarn/bun protocol. Those package managers rewrite it to a
 * real range while packing, so in their monorepos it never reaches the registry.
 * npm does not — and Changesets publishes through `npm publish` for any package
 * manager it doesn't special-case, bun included. A `workspace:` range in a
 * publishable package therefore ships verbatim, and every consumer gets:
 *
 *     npm error code EUNSUPPORTEDPROTOCOL
 *     npm error Unsupported URL Type "workspace:": workspace:*
 *
 * That is exactly how @build-qube/papyra@0.0.3 shipped. Private packages are
 * exempt: they are never published, so the protocol is fine there.
 *
 * Usage: bun run scripts/check-publishable.ts
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Fields that end up in the published manifest and are resolved by the consumer. */
const PUBLISHED_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

interface Manifest {
  name?: string;
  private?: boolean;
  version?: string;
}

const root = join(import.meta.dir, '..');
const problems: string[] = [];
let checked = 0;

for (const workspace of ['packages', 'apps']) {
  const dir = join(root, workspace);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(dir, entry.name, 'package.json');

    let manifest: Manifest & Record<string, unknown>;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      continue;
    }

    if (manifest.private) continue;
    checked++;

    for (const field of PUBLISHED_FIELDS) {
      const deps = manifest[field] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const [dep, range] of Object.entries(deps)) {
        if (range.startsWith('workspace:')) {
          problems.push(
            `${manifest.name}: ${field}.${dep} is "${range}" — npm cannot install that. ` +
              `Use the real version instead; Changesets keeps it in step on release.`,
          );
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error('publishable packages have unpublishable dependency ranges:\n');
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('\nSee scripts/check-publishable.ts for why this matters.');
  process.exit(1);
}

console.log(`✓ ${checked} publishable package(s): no workspace: ranges`);
