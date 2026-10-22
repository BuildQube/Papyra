/**
 * The half of `bun run office fidelity` that runs under Node.
 *
 * It has to be Node: the check runs the office addon's *wasm* build, because wasm has
 * no system fonts and is therefore the same on every machine and in every browser.
 * The native build catalogs whatever fonts the host has installed, so the same file
 * paginates differently on two laptops. Bun cannot load napi's WASI glue; Node can,
 * which is also how CI's test-wasi job runs the PDF addon.
 *
 * Reads a JSON job on stdin, writes one JSON result per line on stdout. Not meant to
 * be run by hand — `scripts/office-engines.ts` builds the job.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const job = JSON.parse(readFileSync(0, 'utf8'));
const { officeEngine } = await import(job.wrapper);

for (const font of readdirSync(job.fonts).sort()) {
  await officeEngine.addFont(
    new Uint8Array(readFileSync(join(job.fonts, font))),
  );
}

/** A page with almost nothing on it — what a font or part that failed to resolve looks like. */
function inkShare(data) {
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 230 || data[i + 1] < 230 || data[i + 2] < 230) ink++;
  }
  return ink / (data.length / 4);
}

/**
 * Share of the page taken by its most common colour, ignoring white. A page that is
 * one non-white colour edge to edge — the all-black slide this was written for — has
 * plenty of ink, so `inkShare` alone never sees it.
 */
function solidShare(data) {
  const counts = new Map();
  for (let i = 0; i < data.length; i += 16) {
    const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    if (key === 0xffffff) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = 0;
  for (const n of counts.values()) best = Math.max(best, n);
  return best / (data.length / 16);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tagged = Buffer.concat([Buffer.from(type), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tagged));
    return Buffer.concat([len, tagged, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Every page of a file on one grey sheet, so a whole document can be looked at once. */
function sheet(pages, width, columns) {
  const gap = 6;
  const tall = Math.max(...pages.map((p) => p.height));
  const rows = Math.ceil(pages.length / columns);
  const w = columns * (width + gap) + gap;
  const h = rows * (tall + gap) + gap;
  const out = Buffer.alloc(w * h * 4, 0x78);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  pages.forEach((p, i) => {
    const x0 = gap + (i % columns) * (width + gap);
    const y0 = gap + Math.floor(i / columns) * (tall + gap);
    for (let y = 0; y < p.height; y++) {
      const from = y * p.stride;
      Buffer.from(p.data.buffer, p.data.byteOffset + from, p.width * 4).copy(
        out,
        ((y0 + y) * w + x0) * 4,
      );
    }
  });
  return png(w, h, out);
}

for (const { name, path } of job.files) {
  const result = { name, pages: 0, blank: [], solid: [], failed: [] };
  try {
    const t0 = performance.now();
    const doc = await officeEngine.open(new Uint8Array(readFileSync(path)));
    result.kind = doc.kind;
    result.pages = doc.pageCount;
    result.openMs = Math.round(performance.now() - t0);
    const rendered = [];
    const t1 = performance.now();
    for (let i = 0; i < doc.pageCount; i++) {
      try {
        const page = await officeEngine.render(doc, i, { fitWidth: job.width })
          .promise;
        if (inkShare(page.data) < 0.001) result.blank.push(i + 1);
        else if (solidShare(page.data) > 0.98) result.solid.push(i + 1);
        rendered.push(page);
      } catch {
        result.failed.push(i + 1);
      }
    }
    result.renderMs = Math.round(performance.now() - t1);
    if (job.sheets && rendered.length > 0) {
      const columns = doc.kind === 'slides' ? 5 : 6;
      writeFileSync(
        join(job.sheets, `${name}.png`),
        sheet(rendered, job.width, columns),
      );
    }
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
process.exit(0);
