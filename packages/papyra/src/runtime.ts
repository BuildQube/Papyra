import {
  backendName,
  configureThreadPool,
  runtime,
} from '@build-qube/papyra-native';

export type Runtime = 'native' | 'wasm';

let initialised = false;

/** Best guess at how many renders this host can genuinely run at once. */
export function hardwareConcurrency(): number {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } })
    .navigator;
  if (typeof nav?.hardwareConcurrency === 'number') {
    return Math.max(1, nav.hardwareConcurrency);
  }
  // Node/Bun: avoid a static `node:os` import so bundlers do not pull it into
  // browser builds.
  const proc = (globalThis as { process?: { env?: Record<string, string> } })
    .process;
  const fromEnv = Number(proc?.env?.PAPYRA_THREADS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 4;
}

export function currentRuntime(): Runtime {
  return runtime() === 'wasm' ? 'wasm' : 'native';
}

export function backend(): string {
  return backendName();
}

/**
 * Prepare the rendering thread pool. Idempotent, and called automatically by
 * {@link open}.
 *
 * Only meaningful on wasm, where `available_parallelism()` is unsupported and rayon
 * would otherwise pin itself to a single thread. Must run before any other rayon use,
 * so we do it before the first document is loaded.
 */
export function init(options: { threads?: number } = {}): void {
  if (initialised) return;
  initialised = true;
  if (currentRuntime() !== 'wasm') return;
  try {
    configureThreadPool(options.threads ?? hardwareConcurrency(), undefined);
  } catch {
    // Already built (another copy of the library got there first). Harmless.
  }
}
