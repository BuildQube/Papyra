import type { Availability, PageBitmap } from '@build-qube/papyra/core';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';

/** How pages travel from the host. */
export type TauriPageFormat = 'png' | 'rgba';

/** A plugin command, by the name Tauri routes it under. */
export const command = (name: string, plugin = 'papyra') =>
  `plugin:${plugin}|${name}`;

/** Ready inside a Tauri WebView; elsewhere, says which plugin it is waiting for. */
export function tauriAvailability(plugin: string): Availability {
  if ('__TAURI_INTERNALS__' in globalThis) return { ok: true };
  return {
    ok: false,
    title: 'Not running inside a Tauri app',
    reason:
      'This engine renders in the app’s host process, through ' +
      `${plugin}, and this page is not in a Tauri WebView.`,
  };
}

/**
 * Where one document's pages are served: `papyra://localhost/<id>/` on macOS, iOS
 * and Linux, `http://papyra.localhost/<id>/` on Android and Windows — Tauri knows
 * which, so ask it rather than sniff.
 */
export function pagesOf(id: number): string {
  return `${convertFileSrc('', 'papyra')}${id}/`;
}

/**
 * One page from the `papyra://` protocol, whichever format the document is: PNG
 * decoded off the main thread to an `ImageBitmap`, or raw RGBA as papyra's own pages
 * are.
 */
export async function fetchPage(
  url: string,
  format: TauriPageFormat,
  signal?: AbortSignal,
): Promise<PageBitmap> {
  const res = await fetch(`${url}&format=${format}`, { signal });
  if (!res.ok) throw new Error(await res.text());
  if (format === 'png') return createImageBitmap(await res.blob());
  const width = Number(res.headers.get('x-width'));
  const height = Number(res.headers.get('x-height'));
  return {
    width,
    height,
    stride: width * 4,
    format: 'rgba8',
    data: new Uint8Array(await res.arrayBuffer()),
  };
}

/** Free a document of any format; closing one already gone is not an error. */
export function closeDocument(id: number): Promise<void> {
  return invoke<void>(command('close'), { id });
}
