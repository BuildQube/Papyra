/**
 * One coverage run across both languages.
 *
 * Emits `coverage/rust.lcov` and `coverage/ts.lcov`, which CI uploads to Codecov
 * under separate flags. Both are plain lcov with repo-root-relative paths, so they
 * can also be fed to `genhtml` locally.
 *
 * The reason this is a script and not two commands in a workflow file is the Rust
 * side. Most of papyra's Rust is never reached by `cargo test`: `packages/bindings`
 * has no `#[test]` at all, and the render path is only ever driven across the napi
 * boundary. Measured on this repo, `cargo test` alone reports 69.52% region coverage
 * with `packages/bindings/src/lib.rs` at a flat 0%; including the JS-driven runs
 * takes it to 91.82% with bindings at 83.38%. A number that calls the most-exercised
 * file in the crate dead is worse than no number.
 *
 * So the addon is built with LLVM instrumentation, the JS suites run against it, and
 * the counters they dump are merged with the ones `cargo test` produces:
 *
 *   1. `cargo llvm-cov show-env` hands us RUSTC_WRAPPER + LLVM_PROFILE_FILE. The
 *      wrapper instruments workspace crates only, so hayro and friends stay out of
 *      both the build time and the report.
 *   2. `napi build` inherits that env and produces an instrumented .node.
 *   3. Every subsequent process inherits LLVM_PROFILE_FILE and writes a .profraw on
 *      exit — `cargo test`, `node --test` and `bun test` alike.
 *   4. llvm-profdata merges them; llvm-cov exports lcov against *both* object sets.
 *
 * Step 4 is why `cargo llvm-cov report` is not used to finish the job: it discovers
 * objects from cargo's own targets and has no flag to add a cdylib, so it reads the
 * merged profile against test binaries alone and reports the bindings crate as dead.
 * Passing the .node and the test binaries together is the whole trick — the two hold
 * separate instantiations of the same functions (the test build carries cfg(test)),
 * so the union is genuinely additive rather than a max.
 *
 * Usage: bun run coverage   (needs ./corpus — run `bun run corpus` first)
 */

import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';

const ROOT = dirname(import.meta.dir);
const OUT = join(ROOT, 'coverage');

/**
 * Files that are real source in the report's eyes but not ours.
 *
 * `fixtures.rs` is `#[cfg(test)] mod fixtures` — a PDF builder used only by the
 * outline and text tests. It is 100% covered by construction and only inflates the
 * total. The registry paths keep dependencies out; the wrapper already excludes
 * them from instrumentation, but a proc-macro expansion can still name one.
 */
const RUST_IGNORE = [
  '/\\.cargo/registry/',
  '/rustc/',
  'crates/papyra-hayro/src/fixtures\\.rs',
].join('|');

/**
 * Parse the `K=V` lines `cargo llvm-cov show-env` prints.
 *
 * It single-quotes only the values that need it, so a parser that requires quotes
 * drops `RUSTC_WRAPPER` — and then the build is simply not instrumented, which
 * surfaces as a plausible-looking report rather than an error. Values that are
 * quoted use the POSIX `'\''` idiom for an embedded quote.
 *
 * `__CARGO_LLVM_COV_RUSTC_WRAPPER_RUSTFLAGS` separates its flags with 0x1F rather
 * than spaces, so the value must survive byte for byte.
 */
function parseShellExports(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    const [, key, raw] = m ?? [];
    if (key === undefined || raw === undefined) continue;
    env[key] = raw.startsWith("'")
      ? raw.slice(1, -1).replaceAll("'\\''", "'")
      : raw;
  }
  return env;
}

/**
 * The object files llvm-cov needs, as repeated `--object` arguments.
 *
 * cargo writes test binaries into the profile's `deps/` with a hash suffix and no
 * extension, alongside `.d`/`.rlib`/`.rmeta`/`.so` metadata that has one. A missing
 * extension plus the executable bit separates them on both Linux and macOS. This is
 * only safe because `cargo llvm-cov clean` ran first — otherwise a binary from an
 * earlier build would be matched against a profile that never touched it.
 */
async function objectArgs(profileDir: string, addon: string) {
  const deps = join(profileDir, 'deps');
  const objects = [addon];
  for (const entry of await readdir(deps, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.includes('.')) continue;
    const path = join(deps, entry.name);
    if ((await Bun.file(path).stat()).mode & 0o111) objects.push(path);
  }
  return objects.flatMap((o) => ['--object', o]);
}

/**
 * Rewrite bun's lcov into repo-root-relative paths and drop what is not ours.
 *
 * `SF:` comes out relative to the directory bun ran in (`src/cache.ts`), which
 * Codecov cannot match to a file in the repo. The generated napi glue gets pulled in
 * by `document.ts` and is not source we write; the preload is scaffolding.
 */
function normaliseTsLcov(lcov: string, pkgDir: string): string {
  const records = lcov.split(/^end_of_record$/m);
  const kept: string[] = [];
  for (const record of records) {
    const file = /^SF:(.*)$/m.exec(record)?.[1];
    if (!file) continue;
    if (file.startsWith('../bindings/') || file.startsWith('test/')) continue;
    kept.push(
      `${record.trimStart().replace(/^SF:.*$/m, `SF:${pkgDir}/${file}`)}end_of_record`,
    );
  }
  return `${kept.join('\n')}\n`;
}

const llvmBin = join(
  dirname((await $`rustc --print target-libdir`.text()).trim()),
  'bin',
);
if (!existsSync(join(llvmBin, 'llvm-profdata'))) {
  console.error(
    'coverage: llvm-tools not found. Run `rustup component add llvm-tools-preview`.',
  );
  process.exit(1);
}
if (!existsSync(join(ROOT, 'corpus'))) {
  console.error('coverage: ./corpus is missing. Run `bun run corpus` first.');
  process.exit(1);
}

// `cargo llvm-cov` writes the wrapper env to stdout and its advisory notes to stderr.
// The bare form is used over `--sh`: same content, one less shell idiom to unpick.
const env = {
  ...process.env,
  ...parseShellExports(await $`cargo llvm-cov show-env`.text()),
};

const profileDir = join(env.CARGO_LLVM_COV_TARGET_DIR ?? 'target', 'coverage');

console.log('coverage: clearing previous profile data');
await $`cargo llvm-cov clean --workspace`.env(env);

// `napi build --platform` passes an explicit `--target`, so the addon lands in
// `target/<host-triple>/coverage` while `cargo test` builds into `target/coverage`.
// `cargo llvm-cov clean` only knows about the latter, so without this the addon is
// whatever a previous run left behind — and cargo, seeing it fresh, will not rebuild
// it. A stale addon still carries a coverage map, so nothing fails: llvm-cov reads it
// happily and reports `packages/bindings/src/lib.rs` at 0%, which looks like a real
// result rather than a build that never happened.
const host = /host: (\S+)/.exec(await $`rustc -vV`.text())?.[1];
if (!host) {
  console.error(
    'coverage: could not determine the host triple from `rustc -vV`.',
  );
  process.exit(1);
}
await $`rm -rf ${join(ROOT, 'target', host, 'coverage')}`;

// The `coverage` profile is release-speed with LTO off — see the note in Cargo.toml.
console.log('coverage: building the instrumented addon');
await $`bunx napi build --platform --profile coverage`
  .cwd(join(ROOT, 'packages/bindings'))
  .env(env);

const targetDir = env.CARGO_LLVM_COV_TARGET_DIR ?? join(ROOT, 'target');
const countProfraw = async () =>
  (await readdir(targetDir)).filter((f) => f.endsWith('.profraw')).length;

/**
 * Give a stage its own profile files instead of cargo-llvm-cov's shared pool.
 *
 * Its default `LLVM_PROFILE_FILE` ends in `%18m`, which is online merging: writers
 * share a pool of 18 files and merge into whichever they get. That is only valid
 * between processes running the *same* coverage map. Here the writers are a cargo
 * test binary, node loading the addon, and bun loading the addon — three different
 * maps — and on a pool collision LLVM discards the mismatched counters rather than
 * failing. It discards them quietly, and which writer loses depends on timing, so
 * this reproduced on Linux CI and not on macOS: the outline and text paths, which
 * only the bun process reaches, came back 23 points low with every test passing.
 *
 * `%p` alone is one file per process, no pool and no merging, so nothing collides.
 * llvm-profdata merges them all at the end anyway, which is where merging belongs.
 */
const stageEnv = (stage: string) => ({
  ...env,
  // Plain `%p`, not cargo-llvm-cov's `%18m` pool: that is online merging, valid only
  // between processes sharing a coverage map, and here the writers are a cargo test
  // binary, node loading the addon and bun loading the addon.
  //
  // Not `%c` (continuous mode) either, which is the textbook answer to a process
  // that never flushes: it needs `-runtime-counter-relocation` on Linux and a
  // `__llvm_prf_cnts` section alignment flag at link time on macOS, and without both
  // it silently profiles nothing. Tried here, it zeroed every stage on macOS. The
  // flush is done explicitly from JS instead — see writeCoverageProfile below.
  LLVM_PROFILE_FILE: join(targetDir, `${stage}-%p.profraw`),
});

console.log('coverage: cargo test');
await $`cargo test --workspace --profile coverage`.env(stageEnv('cargo-test'));
console.log(`  ${await countProfraw()} profraw so far`);

// Drives the napi surface directly: rendering, page sizes, the encoders.
console.log('coverage: bindings tests');
await $`bun run --filter @build-qube/papyra-native test`.env(
  stageEnv('bindings'),
);
console.log(`  ${await countProfraw()} profraw so far`);

// Unit and integration together, in one process, so the wrapper's lcov has a single
// denominator. `--preload` imports the package entrypoint, which is what puts the
// modules no test touches into the report as 0% instead of leaving them out.
console.log('coverage: wrapper tests');
const pkg = join(ROOT, 'packages/papyra');
await $`bun test test/unit test/integration --preload ./test/coverage-entry.ts --coverage --coverage-reporter=lcov --coverage-dir=${OUT}/ts-raw`
  .cwd(pkg)
  .env(stageEnv('wrapper'));
console.log(`  ${await countProfraw()} profraw so far`);

await mkdir(OUT, { recursive: true });
await writeFile(
  join(OUT, 'ts.lcov'),
  normaliseTsLcov(
    await readFile(join(OUT, 'ts-raw/lcov.info'), 'utf8'),
    'packages/papyra',
  ),
);

console.log('coverage: merging profiles');
const profraw = (await readdir(targetDir))
  .filter((f) => f.endsWith('.profraw'))
  .map((f) => join(targetDir, f));
if (profraw.length === 0) {
  console.error('coverage: no .profraw written — nothing ran instrumented.');
  process.exit(1);
}
const profdata = join(OUT, 'papyra.profdata');
await $`${join(llvmBin, 'llvm-profdata')} merge -sparse ${profraw} -o ${profdata}`;

const addon = (await readdir(join(ROOT, 'packages/bindings')))
  .filter((f) => f.endsWith('.node'))
  .map((f) => join(ROOT, 'packages/bindings', f))[0];
if (!addon) {
  console.error(
    'coverage: no .node addon found — the napi build produced nothing.',
  );
  process.exit(1);
}
const objects = await objectArgs(profileDir, addon);

const llvmCov = join(llvmBin, 'llvm-cov');
const common = [
  `--instr-profile=${profdata}`,
  ...objects,
  `--ignore-filename-regex=${RUST_IGNORE}`,
];

/**
 * What each stage actually contributed, merged on its own.
 *
 * The total alone cannot tell a stage that ran and reported nothing from one whose
 * work another stage already covered, and this pipeline's whole failure mode is a
 * number that is wrong but believable. A stage at zero here means its counters were
 * written and then lost, which is not something the totals will ever say out loud.
 */
const contributions: Record<string, number> = {};
console.log('coverage: per-stage contribution (Rust lines covered)');
for (const stage of ['cargo-test', 'bindings', 'wrapper']) {
  const own = profraw.filter((f) => f.includes(`/${stage}-`));
  if (own.length === 0) {
    console.log(`  ${stage.padEnd(11)} no profraw`);
    continue;
  }
  const stageData = join(OUT, `${stage}.profdata`);
  await $`${join(llvmBin, 'llvm-profdata')} merge -sparse ${own} -o ${stageData}`;
  const lcov =
    await $`${llvmCov} export -format=lcov --instr-profile=${stageData} ${objects} --ignore-filename-regex=${RUST_IGNORE}`.text();
  const covered = (lcov.match(/^DA:\d+,[1-9]/gm) ?? []).length;
  console.log(
    `  ${stage.padEnd(11)} ${String(covered).padStart(5)} lines, from ${own.length} profraw`,
  );
  contributions[stage] = covered;
}

// A stage that ran, wrote a profile and covered nothing has lost its counters. That
// is not a number to publish: it cost 7 points of the Rust total and reported a
// three-line `outline()` as dead while its own test passed. The existing
// bindings assertion cannot see it — the other stages keep that file non-zero.
const dead = Object.entries(contributions).filter(([, n]) => n === 0);
if (dead.length > 0) {
  console.error(
    `coverage: ${dead.map(([s]) => s).join(', ')} contributed no covered lines.\n` +
      'The stage ran and wrote a profile, so its counters were discarded rather than\n' +
      'never produced. Publishing this would undercount by however much that stage\n' +
      'uniquely covers. Refusing.',
  );
  process.exit(1);
}
// llvm-cov records absolute paths. Codecov matches an lcov `SF:` against the repo
// tree, so an absolute one from a runner's checkout directory resolves to nothing and
// the whole flag lands as uncovered.
const rustLcov = (
  await $`${llvmCov} export -format=lcov ${common}`.text()
).replaceAll(`SF:${ROOT}/`, 'SF:');
await writeFile(join(OUT, 'rust.lcov'), rustLcov);

// The canary for everything above. `packages/bindings/src/lib.rs` has no `#[test]`
// in it and is reachable only across the napi boundary, so it is covered if and only
// if the instrumented addon was rebuilt, loaded, and its counters merged. Every way
// this pipeline breaks — a stale addon, an unexported LLVM_PROFILE_FILE, an object
// list missing the .node — ends in the same place: a report that still parses, still
// uploads, and quietly reads ~20 points low. Fail instead.
const bindings = rustLcov
  .split(/^end_of_record$/m)
  .find((r) => r.includes('SF:packages/bindings/src/lib.rs'));
const hit = Number(/^LH:(\d+)$/m.exec(bindings ?? '')?.[1] ?? 0);
if (hit === 0) {
  console.error(
    'coverage: packages/bindings/src/lib.rs came out at zero covered lines.\n' +
      'That crate is only reachable from JS, so this means the instrumented addon\n' +
      'never ran — not that the code is untested. Refusing to emit a bogus report.',
  );
  process.exit(1);
}

// The table is the point of running this locally; in CI it is the job log.
await $`${llvmCov} report ${common}`;
console.log(`\ncoverage: wrote ${OUT}/rust.lcov and ${OUT}/ts.lcov`);
