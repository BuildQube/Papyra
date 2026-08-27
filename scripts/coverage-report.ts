/**
 * Turn the two lcov files into the things a reader actually sees: a badge, a
 * per-file PR comment, and the coverage of the diff itself.
 *
 * This exists instead of Codecov. Uploading to a coverage service would mean an
 * account, a repo activation and a token before the badge renders at all, and the
 * numbers would then live somewhere the repo cannot verify. Everything here runs on
 * GitHub: the badge is an SVG committed to an orphan `badges` branch, the baseline
 * for the diff is the previous main run's artifact, and the comment is posted with
 * the `gh` CLI that is already on the runner.
 *
 * What that gives up, honestly: trend history, the sunburst graph, and line-level
 * annotations in the Files-changed view. What it keeps is the part that changes
 * behaviour — a number on the README and a per-file table on every PR saying which
 * way it moved.
 *
 * Usage:
 *   bun run scripts/coverage-report.ts                       # summary.json + badges
 *   bun run scripts/coverage-report.ts --base <summary.json> # ... + a delta column
 *   bun run scripts/coverage-report.ts --diff-base <sha>     # ... + patch coverage
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { $ } from 'bun';

const ROOT = dirname(import.meta.dir);
const OUT = join(ROOT, 'coverage');

/** Coverage of the lines a PR adds, below which the comment calls it out. */
const PATCH_TARGET = 80;

interface FileCoverage {
  flag: string;
  /** Lines instrumented. */
  lf: number;
  /** Lines hit. */
  lh: number;
  /** Hit count per 1-indexed source line, for patch coverage. */
  lines: Record<number, number>;
}

type Summary = {
  files: Record<string, FileCoverage>;
  flags: Record<string, { lf: number; lh: number }>;
  total: { lf: number; lh: number };
};

/**
 * Parse lcov into per-file line data.
 *
 * Only `SF` and `DA` are read. `LF`/`LH` are recomputed from the `DA` records
 * rather than trusted: llvm-cov and bun agree on `DA` but not on whether a line
 * with no executable code belongs in `LF`, and a total that mixes the two
 * conventions is not comparable against itself run to run.
 */
function parseLcov(text: string, flag: string): Record<string, FileCoverage> {
  const files: Record<string, FileCoverage> = {};
  let current: FileCoverage | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      current = { flag, lf: 0, lh: 0, lines: {} };
      files[line.slice(3).trim()] = current;
    } else if (line.startsWith('DA:') && current) {
      const [no, hits] = line.slice(3).trim().split(',').map(Number);
      if (no === undefined || hits === undefined) continue;
      // A line can appear more than once when several regions map to it; the line
      // counts as covered if any of them ran.
      if (!(no in current.lines)) current.lf += 1;
      current.lines[no] = Math.max(current.lines[no] ?? 0, hits);
    }
  }
  for (const file of Object.values(files)) {
    file.lh = Object.values(file.lines).filter((h) => h > 0).length;
  }
  return files;
}

const pct = (lh: number, lf: number) => (lf === 0 ? 100 : (lh / lf) * 100);
const fmt = (n: number) => `${n.toFixed(2)}%`;
const delta = (n: number) =>
  `${n > 0 ? '+' : n < 0 ? '' : '±'}${n.toFixed(2)}%`;

/** Shields-style flat badge, written out rather than fetched from an image host. */
function badge(label: string, value: number): string {
  const text = `${value.toFixed(1)}%`;
  // Verdana at 11px averages ~6.6px per character; the padding is 10px a side.
  const lw = Math.ceil(label.length * 6.6) + 20;
  const rw = Math.ceil(text.length * 6.6) + 20;
  const w = lw + rw;
  const colour =
    value >= 90
      ? '#4c1'
      : value >= 80
        ? '#97ca00'
        : value >= 70
          ? '#dfb317'
          : value >= 60
            ? '#fe7d37'
            : '#e05d44';
  // Text is drawn twice: once in near-black at a 1px offset for the shadow the
  // style is recognised by, then in white on top.
  const caption = (x: number, t: string) =>
    `<text x="${x}" y="15" fill="#010101" fill-opacity=".3">${t}</text>` +
    `<text x="${x}" y="14">${t}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${label}: ${text}">
<title>${label}: ${text}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)">
<rect width="${lw}" height="20" fill="#555"/>
<rect x="${lw}" width="${rw}" height="20" fill="${colour}"/>
<rect width="${w}" height="20" fill="url(#s)"/>
</g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
${caption(lw / 2, label)}
${caption(lw + rw / 2, text)}
</g>
</svg>
`;
}

/**
 * The lines a PR adds, from `git diff`.
 *
 * `--unified=0` so each hunk header names exactly the added lines and nothing
 * around them, and `base...head` so the comparison is against the merge base
 * rather than whatever main has moved on to.
 */
async function addedLines(base: string): Promise<Record<string, number[]>> {
  const diff = await $`git diff --unified=0 --no-color ${base}...HEAD`.text();
  const added: Record<string, number[]> = {};
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6).trim();
    } else if (line.startsWith('@@')) {
      const m = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (!m?.[1] || !file) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      const target = added[file] ?? [];
      added[file] = target;
      for (let i = 0; i < count; i++) target.push(start + i);
    }
  }
  return added;
}

const args = process.argv.slice(2);
const argValue = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const files: Record<string, FileCoverage> = {};
for (const [flag, path] of [
  ['rust', join(OUT, 'rust.lcov')],
  ['ts', join(OUT, 'ts.lcov')],
] as const) {
  if (!existsSync(path)) {
    console.error(
      `coverage-report: ${path} is missing. Run \`bun run coverage\`.`,
    );
    process.exit(1);
  }
  Object.assign(files, parseLcov(await readFile(path, 'utf8'), flag));
}

const summary: Summary = { files, flags: {}, total: { lf: 0, lh: 0 } };
for (const file of Object.values(files)) {
  summary.flags[file.flag] ??= { lf: 0, lh: 0 };
  const flag = summary.flags[file.flag];
  if (!flag) continue;
  flag.lf += file.lf;
  flag.lh += file.lh;
  summary.total.lf += file.lf;
  summary.total.lh += file.lh;
}

await mkdir(OUT, { recursive: true });
await writeFile(
  join(OUT, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
  join(OUT, 'coverage.svg'),
  badge('coverage', pct(summary.total.lh, summary.total.lf)),
);
for (const [flag, t] of Object.entries(summary.flags)) {
  await writeFile(
    join(OUT, `coverage-${flag}.svg`),
    badge(flag === 'ts' ? 'typescript' : flag, pct(t.lh, t.lf)),
  );
}

// ---- the markdown report -----------------------------------------------------

const basePath = argValue('--base');
const base: Summary | undefined =
  basePath && existsSync(basePath)
    ? JSON.parse(await readFile(basePath, 'utf8'))
    : undefined;

const rows: string[] = [];
const row = (
  name: string,
  lh: number,
  lf: number,
  prev?: FileCoverage | { lf: number; lh: number },
) => {
  const now = pct(lh, lf);
  const change = prev === undefined ? '—' : delta(now - pct(prev.lh, prev.lf));
  rows.push(`| ${name} | ${fmt(now)} | ${lh}/${lf} | ${change} |`);
};

const md: string[] = ['## Coverage', ''];
md.push('| | Coverage | Lines | Δ vs main |', '|---|---|---|---|');
row('**Total**', summary.total.lh, summary.total.lf, base?.total);
for (const [flag, t] of Object.entries(summary.flags)) {
  row(flag === 'ts' ? 'TypeScript' : 'Rust', t.lh, t.lf, base?.flags[flag]);
}
md.push(...rows, '');
if (!base) {
  md.push(
    '> No baseline from `main` yet, so the Δ column is empty. It fills in once this',
    '> workflow has run on `main` once.',
    '',
  );
}

const diffBase = argValue('--diff-base');
if (diffBase) {
  const added = await addedLines(diffBase);
  let patchLf = 0;
  let patchLh = 0;
  const changed: string[] = [];
  for (const [path, lineNos] of Object.entries(added)) {
    const file = files[path];
    if (!file) continue;
    const instrumented = lineNos.filter((n) => n in file.lines);
    patchLf += instrumented.length;
    patchLh += instrumented.filter((n) => (file.lines[n] ?? 0) > 0).length;
    changed.push(path);
  }
  if (patchLf > 0) {
    const p = pct(patchLh, patchLf);
    md.push(
      `**Patch coverage: ${fmt(p)}** — ${patchLh} of ${patchLf} added lines covered.` +
        (p < PATCH_TARGET
          ? ` :warning: below the ${PATCH_TARGET}% target.`
          : ''),
      '',
    );
  }

  // Per-file, restricted to what the PR touches: the whole-repo table is noise on a
  // three-file change, and the question a reviewer has is about those three files.
  const table: string[] = [];
  for (const path of changed.sort()) {
    const file = files[path];
    if (!file) continue;
    const prev = base?.files[path];
    const now = pct(file.lh, file.lf);
    table.push(
      `| \`${path}\` | ${fmt(now)} | ${file.lh}/${file.lf} | ${prev ? delta(now - pct(prev.lh, prev.lf)) : 'new'} |`,
    );
  }
  if (table.length > 0) {
    md.push(
      `<details><summary>Per-file coverage for the ${table.length} changed file(s) with coverage data</summary>`,
      '',
      '| File | Coverage | Lines | Δ vs main |',
      '|---|---|---|---|',
      ...table,
      '',
      '</details>',
      '',
    );
  }
}

const report = md.join('\n');
await writeFile(join(OUT, 'report.md'), `${report}\n`);
console.log(report);
