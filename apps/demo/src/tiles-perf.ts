/**
 * Tile renders on browser wasm, against the raw binding — the wrapper's 100 MP cap
 * would refuse the 400% full page this exists to compare against. One `?case=` per
 * fresh page load, because wasm memory never shrinks: its size at the end of a run is
 * that run's peak.
 */
const out = document.getElementById('out') as HTMLPreElement;
const lines: string[] = [];
const log = (s: string) => {
  lines.push(s);
  out.textContent = lines.join('\n');
};

const report = () =>
  void fetch('/__perf', { method: 'POST', body: lines.join('\n') }).catch(
    () => {},
  );
// A headless run has no console to read, so a failure has to arrive the same way.
addEventListener('unhandledrejection', (e) => {
  log(`error: ${e.reason?.stack ?? e.reason}`);
  report();
});

// The napi glue builds its shared memory itself and does not export it.
let memory: WebAssembly.Memory | undefined;
// A subclass, so the glue's own `instanceof` checks still pass.
WebAssembly.Memory = class extends WebAssembly.Memory {
  constructor(d: WebAssembly.MemoryDescriptor) {
    super(d);
    memory = this;
  }
};
const mb = () => ((memory?.buffer.byteLength ?? 0) / 2 ** 20).toFixed(0);

const params = new URLSearchParams(location.search);
const kase = params.get('case') ?? 'tile-1024';
const pageIndex = Number(params.get('page') ?? 0);
const { PdfDocument } = await import('@build-qube/papyra-native');
const bytes = new Uint8Array(await (await fetch('/big.pdf')).arrayBuffer());
const doc = PdfDocument.load(bytes);
const { width, height } = doc.pageSize(pageIndex);
log(`case=${kase} page=${pageIndex} loaded=${mb()}MB`);

async function best(rounds: number, fn: () => Promise<unknown>) {
  let b = Infinity;
  for (let i = 0; i < rounds; i++) {
    const t = performance.now();
    await fn();
    b = Math.min(b, performance.now() - t);
  }
  return b.toFixed(1);
}

// 400% = 288 DPI; fit-width 1600 is Addendum 10's scale.
const deep = 288;
const fit = (1600 / width) * 72;
const px = (dpi: number) => [
  Math.floor((width * dpi) / 72),
  Math.floor((height * dpi) / 72),
];

/** Every tile of an `n` x `n` grid, at most `inFlight` at once. */
async function grid(dpi: number, n: number, inFlight: number) {
  const [w = 0, h = 0] = px(dpi);
  const [tw, th] = [Math.ceil(w / n), Math.ceil(h / n)];
  const cells = Array.from({ length: n * n }, (_, i) => [
    (i % n) * tw,
    Math.floor(i / n) * th,
  ]);
  let first = 0;
  const t = performance.now();
  const worker = async () => {
    for (let c = cells.shift(); c; c = cells.shift()) {
      const [x = 0, y = 0] = c;
      await doc.renderTileAsync(
        pageIndex,
        dpi,
        x,
        y,
        Math.min(tw, w - x),
        Math.min(th, h - y),
      );
      first ||= performance.now() - t;
    }
  };
  await Promise.all(Array.from({ length: inFlight }, worker));
  return `first ${first.toFixed(1)}ms, all ${(performance.now() - t).toFixed(1)}ms`;
}

/** The tiles a 1920x1080 viewport at the page centre needs, 1024px each. */
async function viewport(inFlight: number) {
  const [w = 0, h = 0] = px(deep);
  const [vx, vy] = [w / 2 - 960, h / 2 - 540];
  const cells: number[][] = [];
  for (let y = Math.floor(vy / 1024) * 1024; y < vy + 1080; y += 1024)
    for (let x = Math.floor(vx / 1024) * 1024; x < vx + 1920; x += 1024)
      cells.push([x, y]);
  const count = cells.length;
  let first = 0;
  const t = performance.now();
  const worker = async () => {
    for (let c = cells.shift(); c; c = cells.shift()) {
      await doc.renderTileAsync(
        pageIndex,
        deep,
        c[0] ?? 0,
        c[1] ?? 0,
        1024,
        1024,
      );
      first ||= performance.now() - t;
    }
  };
  await Promise.all(Array.from({ length: inFlight }, worker));
  return `${count} tiles, first ${first.toFixed(1)}ms, all ${(performance.now() - t).toFixed(1)}`;
}

const [w = 0, h = 0] = px(deep);
const cases: Record<string, () => Promise<string>> = {
  'full-fit': () => best(3, () => doc.renderPageAsync(pageIndex, fit)),
  'full-400': () => best(3, () => doc.renderPageAsync(pageIndex, deep)),
  'tile-1024': () =>
    best(3, () =>
      doc.renderTileAsync(pageIndex, deep, w / 2, h / 2, 1024, 1024),
    ),
  'tile-512': () =>
    best(3, () => doc.renderTileAsync(pageIndex, deep, w / 2, h / 2, 512, 512)),
  'grid16-fit': () => grid(fit, 4, 4),
  'grid16-400': () => grid(deep, 4, 4),
  'grid4-400': () => grid(deep, 2, 4),
  'grid16-400-1': () => grid(deep, 4, 1),
  'viewport-400-1': () => viewport(1),
  'viewport-400-4': () => viewport(4),
};
const run = cases[kase];
if (!run) throw new Error(`no case ${kase}`);
// One untimed pass so the timed ones run tiered-up code.
await doc.renderTileAsync(pageIndex, fit, 0, 0, 256, 256);
const result = await run();
log(
  `${kase.padEnd(16)} ${result}${/^\d/.test(result) ? 'ms' : ''}  peak=${mb()}MB`,
);
report();
