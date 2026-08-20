/**
 * Isolates where browser wasm time actually goes. No React, so nothing but the
 * engine is being measured.
 */
const out = document.getElementById('out') as HTMLPreElement;
const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join('\n');
  console.log(`[perf] ${s}`);
};

async function bestOf<T>(
  rounds: number,
  fn: () => Promise<T>,
): Promise<{ best: number; all: number[] }> {
  const all: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t = performance.now();
    await fn();
    all.push(performance.now() - t);
  }
  return { best: Math.min(...all), all };
}

const row = (label: string, best: number, pages: number, all: number[]) =>
  log(
    `${label.padEnd(34)}${best.toFixed(1).padStart(8)}ms  ${(best / pages)
      .toFixed(2)
      .padStart(7)} ms/pg   [${all.map((x) => x.toFixed(0)).join(' ')}]`,
  );

log(
  `crossOriginIsolated=${globalThis.crossOriginIsolated} cores=${navigator.hardwareConcurrency}`,
);

const mod = await import('@build-qube/papyra');
mod.init();
const bytes = new Uint8Array(
  await (await fetch('/tracemonkey.pdf')).arrayBuffer(),
);
const doc = await mod.open(bytes);
const N = doc.pageCount;
log(`runtime=${mod.currentRuntime()} pages=${N}\n`);

// Warm V8 up properly before measuring: a 4.3MB module starts in Liftoff and
// tiers up to TurboFan only after the hot paths have run a few times.
log('warming (3 full passes)…');
for (let i = 0; i < 3; i++) await doc.renderPages(0, N, { dpi: 150 });
log('');

const all = await bestOf(5, () => doc.renderPages(0, N, { dpi: 150 }));
row('renderPages(all) @150', all.best, N, all.all);

for (const c of [1, 2, 3, 4, 5, 6, 8, 12, 16]) {
  const r = await bestOf(3, async () => {
    let n = 0;
    for await (const _ of doc.stream({ dpi: 150, concurrency: c })) n++;
    return n;
  });
  row(`stream concurrency=${String(c).padStart(2)}`, r.best, N, r.all);
}

const one = await bestOf(10, () => doc.renderPage(0, { dpi: 150 }));
row('single renderPage(0)', one.best, 1, one.all);

// Same browser, same page, same DPI: the only comparison that actually counts.
log('');
const { openWithPdfjs, renderPageToCanvas } = await import('./lib/pdfjs.js');
const jdoc = await openWithPdfjs(bytes);
for (let i = 0; i < 2; i++) {
  for (let p = 1; p <= jdoc.numPages; p++) {
    await renderPageToCanvas(await jdoc.getPage(p), 150);
  }
}
const js = await bestOf(3, async () => {
  for (let p = 1; p <= jdoc.numPages; p++) {
    const pg = await jdoc.getPage(p);
    await renderPageToCanvas(pg, 150);
    pg.cleanup();
  }
});
row('pdf.js all pages @150', js.best, N, js.all);

const jsOne = await bestOf(10, async () =>
  renderPageToCanvas(await jdoc.getPage(1), 150),
);
row('pdf.js single page', jsOne.best, 1, jsOne.all);

log('');
log(`papyra is ${(js.best / all.best).toFixed(2)}x pdf.js on throughput`);
log(`papyra is ${(jsOne.best / one.best).toFixed(2)}x pdf.js on a single page`);

log('\ndone.');

// Report back so this can be run headless, with no debugger attached.
void fetch('/__perf', { method: 'POST', body: lines.join('\n') }).catch(
  () => {},
);
