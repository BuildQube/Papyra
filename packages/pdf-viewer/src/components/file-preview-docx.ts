import { defineRenderer } from '@/lib/file-preview-core';

/**
 * Word documents, laid out as HTML by `docx-preview`. The layout is approximate —
 * text, tables, lists and images come through well, floating shapes and complex
 * sections less so — and the view says as much.
 *
 * Matched by name, like the spreadsheet renderer: a `.docx` is a zip, and so is every
 * `.xlsx`, `.pptx` and `.zip`, with nothing in the first 512 bytes to tell them apart.
 * The view checks the package's content types before rendering, so a workbook or an
 * archive that has been renamed is refused rather than drawn as garbage.
 *
 * Legacy `.doc` is not here. It is an OLE binary with no usable browser renderer, so
 * it falls through to the download card.
 *
 * About 55 KB gzipped (`docx-preview` and `jszip`), fetched only when a Word document
 * is opened. `docxRenderer.with({ engine: 'papyra' })` swaps in a real pagination by
 * papyra over WordCraft instead — see `DocxFileViewOptions`.
 */
export const docxRenderer = defineRenderer({
  id: 'docx',
  label: 'Word',
  extensions: ['.docx', '.docm', '.dotx', '.dotm'],
  mimes: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    'application/vnd.ms-word.document.macroenabled.12',
    'application/vnd.ms-word.template.macroenabled.12',
  ],
  load: () =>
    import('./file-preview-docx-engine').then((m) => m.DocxEngineView),
});
