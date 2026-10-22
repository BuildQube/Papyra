import { describe, expect, test } from 'bun:test';
import type { Workbook } from '@build-qube/papyra';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkbookView } from '../../src/components/file-preview-sheet.js';
import { TiffFileView } from '../../src/components/file-preview-tiff-view.js';

/**
 * An opener of the app's own — `@build-qube/papyra-tauri`'s, say — runs where papyra's
 * wasm cannot, so the views must not stop it at the isolation guard. Bun is not
 * cross-origin isolated, which is exactly the Tauri WebView's position.
 *
 * In `test/integration` because the views import papyra's main entry, which loads
 * the addon.
 */
const BLOCKED = 'not cross-origin isolated';
const file = new File([], 'x');
const never = () => new Promise<never>(() => {});
const settings = { displayRenderTime: false };

describe('injected openers', () => {
  test('a TIFF with papyra’s own opener waits on isolation; one with its own does not', () => {
    expect(
      renderToStaticMarkup(
        <TiffFileView file={file} options={{}} {...settings} />,
      ),
    ).toContain(BLOCKED);
    expect(
      renderToStaticMarkup(
        <TiffFileView file={file} options={{ open: never }} {...settings} />,
      ),
    ).not.toContain(BLOCKED);
  });

  test('so does a workbook', () => {
    expect(renderToStaticMarkup(<WorkbookView file={file} />)).toContain(
      BLOCKED,
    );
    expect(
      renderToStaticMarkup(
        <WorkbookView file={file} open={never as () => Promise<Workbook>} />,
      ),
    ).not.toContain(BLOCKED);
  });
});
