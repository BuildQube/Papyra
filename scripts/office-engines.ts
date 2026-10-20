/**
 * Keep papyra-office's two engines current, and measure what a bump changed.
 *
 * WordCraft and DeckCraft are git-pinned in `crates/papyra-office/Cargo.toml` — they
 * are not on crates.io — and they move fast: in their first twelve days each gained
 * over 900 commits. A rev nobody revisits is a renderer nobody improves, and a rev
 * bumped blind is a regression nobody sees. This is the tool for the procedure in
 * `.agents/skills/office-engines/SKILL.md`.
 *
 *   bun run office status            how far each pin is behind upstream, by crate
 *   bun run office bump [engine]     move a pin to upstream HEAD (or --rev <sha>)
 *     --fork <owner/repo> --rev <sha>  pin to a fork carrying an unmerged upstream fix
 *   bun run office fidelity          render the corpus, compare with the baseline
 *
 * `fidelity` renders through the **wasm** build under Node, with the same four
 * metric-compatible fonts the demo loads. wasm has no system fonts, so its pagination
 * is the same on every machine and in every browser; the native build catalogs the
 * host's fonts, and its page counts move from one laptop to the next. Options:
 *
 *   --update        write the result as the new baseline
 *   --sheets <dir>  write one contact sheet per file, every page on it
 *   --width <px>    page width to render at (default 240)
 *   --only <text>   only files whose name contains this
 *   --no-build      use the wasm and wrapper already built
 *
 * The corpus is real Office-authored files from Apache POI's test data, fetched into
 * the gitignored `corpus/office`, each with the page or slide count Office itself
 * saved in `docProps/app.xml` — the closest thing to a reference rendering we have.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = join(import.meta.dir, '..');
const MANIFEST = join(ROOT, 'crates/papyra-office/Cargo.toml');
const BASELINE = join(ROOT, 'crates/papyra-office/fidelity.json');
const CORPUS = join(ROOT, 'corpus/office');
const FONTS = join(CORPUS, 'fonts');

/**
 * The crates papyra-office depends on, directly or through them. A commit touching
 * none of these cannot change what we render — the editors, MCP servers and UI
 * crates are most of each repo's churn.
 */
const ENGINES = {
  wordcraft: {
    repo: 'storytold/wordcraft',
    crates: ['doc', 'docx', 'fonts', 'geom', 'layout', 'proof', 'render'],
    probe: 'wordcraft-render',
  },
  deckcraft: {
    repo: 'storytold/deckcraft',
    crates: ['color', 'fonts', 'geom', 'model', 'pptx', 'render', 'text'],
    probe: 'deckcraft-render',
  },
} as const;
type Engine = keyof typeof ENGINES;

/** Pinned, so a baseline means the same bytes next month. */
const POI =
  'https://raw.githubusercontent.com/apache/poi/7660dfb20956e970adf309b36f31bab4ab35d556/test-data';
const GOOGLE_FONTS =
  'https://cdn.jsdelivr.net/gh/google/fonts@51303ca9e8ac9dcea7b12d307ba568fd0e6fcfca/ofl';

/**
 * `office` is the count Office saved in `docProps/app.xml`, or null where the file
 * has none or it is wrong. `note` is what a reviewer should look for on the sheet —
 * the defects found when this corpus was first assembled.
 */
const FILES: readonly {
  name: string;
  url: string;
  office: number | null;
  note?: string;
}[] = [
  { name: 'Bug51170.docx', url: `${POI}/document/Bug51170.docx`, office: 7 },
  {
    name: 'calendar-ru.docx',
    url: `${POI}/document/bib-chernigovka.netdo.ru_download_docs_17459.docx`,
    office: 15,
    note: 'one page over Office (16 vs 15); title page, border and texture draw',
  },
  {
    name: 'pcb-paper.docx',
    url: `${POI}/document/bug59058.docx`,
    office: 52,
  },
  {
    name: 'bug65649.docx',
    url: `${POI}/document/bug65649.docx`,
    office: null,
    note: 'app.xml claims 1 page; blank pages at section breaks, unverified',
  },
  {
    name: 'saut_page.docx',
    url: `${POI}/document/saut_page.docx`,
    office: 3,
    note: 'written by LibreOffice; explicit page breaks',
  },
  {
    name: 'heading123.docx',
    url: `${POI}/document/heading123.docx`,
    office: 1,
  },
  {
    name: 'VariousPictures.docx',
    url: `${POI}/document/VariousPictures.docx`,
    office: 1,
  },
  {
    name: 'MultipleBodyBug.docx',
    url: `${POI}/document/MultipleBodyBug.docx`,
    office: 1,
  },
  {
    name: 'issue_51265_3.docx',
    url: `${POI}/document/issue_51265_3.docx`,
    office: 1,
  },
  {
    name: 'alterman_security.pptx',
    url: `${POI}/slideshow/alterman_security.pptx`,
    office: 23,
    note: 'slide 16 has a WMF picture; slide 10 was solid black before a31b990',
  },
  {
    name: 'HowWeRefactor.pptx',
    url: `${POI}/slideshow/ca.ubc.cs.people_~emhill_presentations_HowWeRefactor.pptx`,
    office: 28,
    note: 'animation builds: every state is drawn at once',
  },
  {
    name: 'Performance_Up.pptx',
    url: `${POI}/slideshow/2411-Performance_Up.pptx`,
    office: 48,
  },
  {
    name: 'aascu-cooper.pptx',
    url: `${POI}/slideshow/aascu.org_hbcu_leadershipsummit_cooper_.pptx`,
    office: 16,
  },
  {
    name: 'GeomLec1.pptx',
    url: `${POI}/slideshow/ae.ac.uaeu.faculty_nafaachbili_GeomLec1.pptx`,
    office: 14,
  },
  { name: 'aptia.pptx', url: `${POI}/slideshow/aptia.pptx`, office: 9 },
  {
    name: 'ecodesign-elektronik.pptx',
    url: `${POI}/slideshow/at.ecodesign.www_downloads_Vertiefungsvortrag_elektronik.pptx`,
    office: 34,
  },
  {
    name: 'ececapstone.pptx',
    url: `${POI}/slideshow/ececapstonespring2012.pptx`,
    office: null,
  },
];

/** What the demo registers, so the check paginates as the demo does. */
const FONT_FILES = [
  'carlito/Carlito-Regular.ttf',
  'carlito/Carlito-Bold.ttf',
  'carlito/Carlito-Italic.ttf',
  'carlito/Carlito-BoldItalic.ttf',
  'caladea/Caladea-Regular.ttf',
  'caladea/Caladea-Bold.ttf',
  'arimo/Arimo%5Bwght%5D.ttf',
  'tinos/Tinos-Regular.ttf',
  'tinos/Tinos-Bold.ttf',
];

interface Result {
  name: string;
  kind?: string;
  pages: number;
  blank: number[];
  solid: number[];
  failed: number[];
  error?: string;
  openMs?: number;
  renderMs?: number;
}

interface Baseline {
  revs: Record<Engine, string>;
  width: number;
  results: Record<string, Omit<Result, 'name' | 'openMs' | 'renderMs'>>;
}

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    rev: { type: 'string' },
    fork: { type: 'string' },
    update: { type: 'boolean', default: false },
    sheets: { type: 'string' },
    width: { type: 'string', default: '240' },
    only: { type: 'string' },
    'no-build': { type: 'boolean', default: false },
  },
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sh(cmd: string[], cwd = ROOT): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'inherit' });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`failed: ${cmd.join(' ')}`);
  return out;
}

async function run(cmd: string[], cwd = ROOT): Promise<void> {
  console.log(`$ ${cmd.join(' ')}`);
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`failed: ${cmd.join(' ')}`);
}

/** GitHub's REST API through `gh`, which carries the user's token and its rate limit. */
async function gh<T>(path: string): Promise<T> {
  return JSON.parse(await sh(['gh', 'api', path])) as T;
}

interface Pin {
  /** `owner/name`: upstream, or a fork carrying a fix upstream has not merged. */
  repo: string;
  rev: string;
}

/**
 * What the manifest pins each engine to. The repo is read rather than assumed, so a
 * pin on a fork is visible to `status`, and `bump` can say what leaving it drops.
 */
async function pins(): Promise<Record<Engine, Pin>> {
  const manifest = await readFile(MANIFEST, 'utf8');
  const out = {} as Record<Engine, Pin>;
  for (const engine of Object.keys(ENGINES) as Engine[]) {
    const found = new Set(
      [
        ...manifest.matchAll(
          new RegExp(
            `github\\.com/([\\w.-]+/${engine})", rev = "([0-9a-f]{40})"`,
            'g',
          ),
        ),
      ].map((m) => `${m[1]}@${m[2]}`),
    );
    if (found.size !== 1) {
      throw new Error(
        `${engine}: expected one repo and rev in ${MANIFEST}, found ${found.size}`,
      );
    }
    const [repo, rev] = ([...found][0] as string).split('@') as [
      string,
      string,
    ];
    out[engine] = { repo, rev };
  }
  return out;
}

async function pinnedRevs(): Promise<Record<Engine, string>> {
  const all = await pins();
  return Object.fromEntries(
    Object.entries(all).map(([e, p]) => [e, p.rev]),
  ) as Record<Engine, string>;
}

/**
 * Commits `rev` has that upstream's `base` does not: a fork's unmerged fixes. GitHub
 * serves a fork's commits through the parent repo, so one compare covers both.
 */
async function carried(
  repo: string,
  base: string,
  rev: string,
): Promise<{ sha: string; commit: { message: string } }[]> {
  const c = await gh<{
    ahead_by: number;
    commits: { sha: string; commit: { message: string } }[];
  }>(`repos/${repo}/compare/${base}...${rev}`);
  return c.ahead_by > 0 ? c.commits : [];
}

async function status(): Promise<void> {
  const current = await pins();
  for (const [engine, { repo, crates }] of Object.entries(ENGINES)) {
    const { repo: pinnedRepo, rev: pinned } = current[engine as Engine];
    const head = await gh<{
      sha: string;
      commit: { committer: { date: string } };
    }>(`repos/${repo}/commits/main`);
    const fork = pinnedRepo === repo ? '' : ` on fork ${pinnedRepo}`;
    console.log(
      `\n${engine}  pinned ${pinned.slice(0, 12)}${fork}  upstream ${head.sha.slice(0, 12)} (${head.commit.committer.date.slice(0, 10)})`,
    );
    if (fork) {
      const own = await carried(repo, head.sha, pinned);
      console.log(
        own.length === 0
          ? '  the fork carries nothing upstream lacks: bump back to upstream'
          : `  carries ${own.length} commit(s) upstream has not merged:`,
      );
      for (const c of own) {
        console.log(
          `    ${c.sha.slice(0, 9)} ${c.commit.message.split('\n')[0]?.slice(0, 90)}`,
        );
      }
    }
    if (head.sha === pinned) {
      console.log('  up to date');
      continue;
    }
    const compare = await gh<{
      behind_by: number;
      html_url: string;
    }>(`repos/${repo}/compare/${head.sha}...${pinned}`);
    if (compare.behind_by === 0) {
      console.log('  up to date');
      continue;
    }
    console.log(
      `  ${compare.behind_by} commits behind  https://github.com/${repo}/compare/${pinned}...${head.sha}`,
    );
    // The compare API lists at most 300 files, so a big gap undercounts — the
    // per-crate commit query below does not.
    const since = (
      await gh<{ commit: { committer: { date: string } } }>(
        `repos/${repo}/commits/${pinned}`,
      )
    ).commit.committer.date;
    for (const crate of crates) {
      const commits = await gh<{ sha: string; commit: { message: string } }[]>(
        `repos/${repo}/commits?sha=${head.sha}&path=crates/${crate}&since=${since}&per_page=100`,
      );
      const fresh = commits.filter((c) => c.sha !== pinned);
      if (fresh.length === 0) continue;
      console.log(
        `  crates/${crate}: ${fresh.length}${fresh.length === 100 ? '+' : ''} commits`,
      );
      for (const c of fresh.slice(0, 5)) {
        console.log(
          `    ${c.sha.slice(0, 9)} ${c.commit.message.split('\n')[0]?.slice(0, 90)}`,
        );
      }
    }
  }
}

async function bump(): Promise<void> {
  const which = positionals[1] ?? 'all';
  const engines = (
    which === 'all' ? Object.keys(ENGINES) : [which]
  ) as Engine[];
  for (const engine of engines) {
    if (!(engine in ENGINES)) throw new Error(`unknown engine: ${engine}`);
  }
  if (args.rev && engines.length !== 1) {
    throw new Error('--rev needs a single engine: bump wordcraft --rev <sha>');
  }
  if (args.fork && !args.rev) {
    throw new Error(
      '--fork needs --rev: pin the fix commit, never a branch that can move',
    );
  }
  const current = await pins();
  let manifest = await readFile(MANIFEST, 'utf8');
  for (const engine of engines) {
    const { repo, probe } = ENGINES[engine];
    const from = current[engine];
    const to = args.fork ?? repo;
    const rev =
      args.rev ?? (await gh<{ sha: string }>(`repos/${repo}/commits/main`)).sha;
    if (!/^[0-9a-f]{40}$/.test(rev)) {
      throw new Error(`--rev must be a full 40-character sha, got ${rev}`);
    }
    if (rev === from.rev && to === from.repo) {
      console.log(`${engine}: already at ${rev.slice(0, 12)}`);
      continue;
    }
    // Leaving a fork is the point of having one, once upstream has merged its fix;
    // before then it silently reintroduces the bug the fork existed for.
    if (from.repo !== repo) {
      const dropped = await carried(repo, rev, from.rev);
      for (const c of dropped) {
        console.warn(
          `warning: ${engine} ${rev.slice(0, 12)} lacks ${c.sha.slice(0, 9)} from ${from.repo}: ${c.commit.message.split('\n')[0]}`,
        );
      }
    }
    manifest = manifest.replaceAll(
      `github.com/${from.repo}", rev = "${from.rev}"`,
      `github.com/${to}", rev = "${rev}"`,
    );
    await writeFile(MANIFEST, manifest);
    console.log(
      `${engine}: ${from.rev.slice(0, 12)} -> ${rev.slice(0, 12)}${to === repo ? '' : ` on ${to}`}`,
    );
    // Resolves the new rev into Cargo.lock, and with it any dependency the engine
    // raised; `cargo check` below is what finds the API breaks.
    await run(['cargo', 'update', '-p', probe]);
  }
  await run(['cargo', 'check', '-p', 'papyra-office', '--color', 'never']);
}

async function fetchCorpus(): Promise<void> {
  await mkdir(FONTS, { recursive: true });
  const wanted = [
    ...FILES.map((f) => ({ url: f.url, to: join(CORPUS, f.name) })),
    ...FONT_FILES.map((f) => ({
      url: `${GOOGLE_FONTS}/${f}`,
      to: join(FONTS, decodeURIComponent(f.split('/')[1] as string)),
    })),
  ];
  for (const { url, to } of wanted) {
    if (await exists(to)) continue;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    await writeFile(to, new Uint8Array(await res.arrayBuffer()));
    console.log(`fetched ${to.slice(ROOT.length + 1)}`);
  }
}

/** Distance from Office's own count, the one number that says better or worse. */
function drift(pages: number, office: number | null): number | null {
  return office === null ? null : Math.abs(pages - office);
}

async function fidelity(): Promise<void> {
  const width = Number(args.width);
  await fetchCorpus();
  if (!args['no-build']) {
    await run([
      'bun',
      'run',
      '--filter',
      '@build-qube/papyra-office-native',
      'build:wasm',
    ]);
    await run(['bun', 'run', '--filter', '@build-qube/papyra', 'build']);
  }
  if (args.sheets) await mkdir(args.sheets, { recursive: true });

  const files = FILES.filter((f) => !args.only || f.name.includes(args.only));
  const job = {
    wrapper: join(ROOT, 'packages/papyra/dist/office.js'),
    fonts: FONTS,
    width,
    sheets: args.sheets ?? null,
    files: files.map((f) => ({ name: f.name, path: join(CORPUS, f.name) })),
  };
  const proc = Bun.spawn(
    ['node', join(import.meta.dir, 'office-fidelity-run.mjs')],
    {
      cwd: ROOT,
      stdin: new TextEncoder().encode(JSON.stringify(job)),
      stdout: 'pipe',
      stderr: 'pipe',
      // `error`, not `1`: anything else falls back to a native addon and measures the
      // wrong thing without saying so.
      env: { ...process.env, NAPI_RS_FORCE_WASI: 'error' },
    },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    console.error(err);
    throw new Error('the fidelity run failed');
  }
  const results = out
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Result);

  const baseline = (await exists(BASELINE))
    ? (JSON.parse(await readFile(BASELINE, 'utf8')) as Baseline)
    : null;
  if (baseline && baseline.width !== width) {
    console.warn(
      `note: the baseline was rendered at ${baseline.width}px; blank/solid detection may differ at ${width}px`,
    );
  }

  const better: string[] = [];
  const worse: string[] = [];
  const rows: string[][] = [
    ['file', 'pages', 'office', 'base', 'flags', 'open', 'render'],
  ];
  for (const r of results) {
    const spec = FILES.find((f) => f.name === r.name);
    const was = baseline?.results[r.name];
    const flags = [
      r.error ? `ERROR ${r.error.slice(0, 50)}` : '',
      r.failed.length ? `failed ${r.failed.join(',')}` : '',
      r.blank.length ? `blank ${r.blank.join(',')}` : '',
      r.solid.length ? `solid ${r.solid.join(',')}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    rows.push([
      r.name,
      String(r.pages),
      spec?.office === null || spec === undefined ? '-' : String(spec.office),
      was ? String(was.pages) : '-',
      flags,
      r.openMs === undefined ? '' : `${r.openMs}ms`,
      r.renderMs === undefined ? '' : `${r.renderMs}ms`,
    ]);
    if (!was) continue;

    const office = spec?.office ?? null;
    const before = drift(was.pages, office);
    const after = drift(r.pages, office);
    if (before !== null && after !== null && after !== before) {
      (after < before ? better : worse).push(
        `${r.name}: ${was.pages} -> ${r.pages} pages (Office says ${office})`,
      );
    }
    for (const key of ['failed', 'blank', 'solid'] as const) {
      const gone = was[key].filter((p) => !r[key].includes(p));
      const fresh = r[key].filter((p) => !was[key].includes(p));
      if (gone.length)
        better.push(`${r.name}: no longer ${key}: ${gone.join(',')}`);
      if (fresh.length)
        worse.push(`${r.name}: newly ${key}: ${fresh.join(',')}`);
    }
    if (was.error && !r.error) better.push(`${r.name}: opens now`);
    if (r.error && !was.error)
      worse.push(`${r.name}: no longer opens: ${r.error}`);
  }

  const widths =
    rows[0]?.map((_, i) =>
      Math.max(...rows.map((row) => (row[i] ?? '').length)),
    ) ?? [];
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  '));
  }
  const revs = await pinnedRevs();
  if (baseline) {
    const same = (Object.keys(revs) as Engine[]).every(
      (e) => revs[e] === baseline.revs[e],
    );
    console.log(
      same
        ? '\nbaseline is at these same revs'
        : `\nbaseline: ${Object.entries(baseline.revs)
            .map(([e, r]) => `${e} ${r.slice(0, 12)}`)
            .join(', ')}`,
    );
    console.log(`better (${better.length}):`);
    for (const line of better) console.log(`  + ${line}`);
    console.log(`worse (${worse.length}):`);
    for (const line of worse) console.log(`  - ${line}`);
  } else {
    console.log('\nno baseline yet: run with --update to record one');
  }
  for (const f of files.filter((f) => f.note)) {
    console.log(`look at ${f.name}: ${f.note}`);
  }

  if (args.update) {
    if (args.only)
      throw new Error(
        '--update with --only would drop files from the baseline',
      );
    const next: Baseline = {
      revs,
      width,
      results: Object.fromEntries(
        results.map(({ name, openMs: _o, renderMs: _r, ...rest }) => [
          name,
          rest,
        ]),
      ),
    };
    await writeFile(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    // In biome's own layout, so the next bump's diff is only what changed.
    await run(['bunx', 'biome', 'format', '--write', BASELINE]);
    console.log(`wrote ${BASELINE.slice(ROOT.length + 1)}`);
  } else if (worse.length > 0) {
    process.exitCode = 1;
  }
}

const command = positionals[0];
if (command === 'status') await status();
else if (command === 'bump') await bump();
else if (command === 'fidelity') await fidelity();
else {
  console.error(
    'usage: bun run office <status | bump [wordcraft|deckcraft|all] [--rev <sha>] | fidelity [--update] [--sheets <dir>]>',
  );
  process.exit(2);
}
