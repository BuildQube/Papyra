import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CORPUS_DIR = join(import.meta.dir, '..', '..', '..', 'corpus');

export interface CorpusEntry {
  name: string;
  bytes: Uint8Array;
}

export function loadCorpus(exclude: readonly string[] = []): CorpusEntry[] {
  let files: string[];
  try {
    files = readdirSync(CORPUS_DIR)
      .filter((f: string) => f.endsWith('.pdf'))
      .sort();
  } catch {
    throw new Error(
      `no corpus at ${CORPUS_DIR} — run \`bun run corpus\` from the repo root first`,
    );
  }
  return files
    .filter((f) => !exclude.includes(f))
    .map((name) => ({ name, bytes: readFileSync(join(CORPUS_DIR, name)) }));
}

export function read(name: string): Uint8Array {
  return readFileSync(join(CORPUS_DIR, name));
}
