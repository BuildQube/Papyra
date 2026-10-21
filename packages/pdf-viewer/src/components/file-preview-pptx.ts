import { defineRenderer } from '@/lib/file-preview-core';

/**
 * PowerPoint decks, drawn slide by slide by papyra in Rust over DeckCraft — shapes,
 * pictures, theme colours, tables and charts, without a server or an Office install.
 * Experimental: DeckCraft is young, and a real deck may differ from PowerPoint.
 *
 * Matched by name, as Word and spreadsheets are: a `.pptx` is a zip like the others.
 * papyra reads the package's content types before drawing, so a renamed workbook or
 * document is refused rather than drawn as garbage. Legacy `.ppt` is not here.
 *
 * Takes `fonts`, as `pptxRenderer.with({ fonts: [...] })` — without them a browser
 * has nothing like Calibri, and slide text comes out in Ubuntu Light. Needs a
 * cross-origin isolated page, and fetches its own wasm module (separate from the PDF
 * one) the first time a deck is opened.
 */
export const pptxRenderer = defineRenderer({
  id: 'pptx',
  label: 'PowerPoint',
  extensions: ['.pptx', '.pptm', '.potx', '.potm', '.ppsx', '.ppsm'],
  mimes: [
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.presentationml.template',
    'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
    'application/vnd.ms-powerpoint.presentation.macroenabled.12',
    'application/vnd.ms-powerpoint.template.macroenabled.12',
    'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
  ],
  load: () =>
    import('./file-preview-office-view').then((m) => m.OfficeFileView),
});
