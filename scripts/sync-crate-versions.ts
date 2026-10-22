/**
 * Give the published crates the npm packages' version, after `changeset version`.
 *
 * The crates release beside the `fixed` npm group on the same number, so this runs
 * inside the root `version` script, which is the command the Version Packages PR is
 * generated with. Running it as a later step in release.yml would bump the crates on
 * a commit nobody reviewed, if it reached a commit at all.
 *
 * Touches the root workspace's version, its path dependencies' `version`, the same
 * for tauri-plugin-papyra (its own workspace), the git-only office plugin beside it
 * — unpublished, but an app takes it at the same tag as the plugin, so their
 * numbers should agree — and both lockfiles.
 *
 * Usage: bun run scripts/sync-crate-versions.ts
 */
import { join } from 'node:path';
import papyra from '../packages/papyra/package.json' with { type: 'json' };

const root = join(import.meta.dir, '..');
const { version } = papyra;

/** Each pattern must match exactly as often as stated, so a reshaped manifest fails loudly. */
async function rewrite(path: string, edits: [RegExp, number][]) {
  const file = join(root, path);
  let text = await Bun.file(file).text();
  for (const [pattern, count] of edits) {
    const hits = text.match(pattern)?.length ?? 0;
    if (hits !== count)
      throw new Error(`${path}: ${pattern} matched ${hits}, expected ${count}`);
    text = text.replace(pattern, `$1${version}`);
  }
  await Bun.write(file, text);
}

const deps =
  /(\npapyra-(?:core|encode|hayro|tables|tiff) = \{[^}\n]*version = ")[^"]+/g;
const packageVersion = /(\[package\][^[]*?\nversion = ")[^"]+/g;
await rewrite('Cargo.toml', [
  [/(\[workspace\.package\]\nversion = ")[^"]+/g, 1],
  [deps, 5],
]);
await rewrite('crates/tauri-plugin-papyra/Cargo.toml', [
  [packageVersion, 1],
  [deps, 5],
]);
await rewrite('crates/tauri-plugin-papyra/office/Cargo.toml', [
  [packageVersion, 1],
]);

// `-w` re-resolves only the workspace's own packages, and path dependencies are
// always read from their manifests, so no registry crate moves.
for (const dir of ['.', 'crates/tauri-plugin-papyra']) {
  await Bun.$`cargo update -w`.cwd(join(root, dir));
}
console.log(`crates set to ${version}`);
