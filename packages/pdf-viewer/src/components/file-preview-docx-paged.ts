import { defineRenderer } from '@/lib/file-preview-core';

/**
 * Word documents, paginated and drawn by papyra in Rust over WordCraft — as Word would
 * print them, with page breaks, headers and footers where Word puts them — in the PDF
 * viewer's continuous column. The alternative to `docxRenderer`'s approximate HTML:
 * list whichever you want first, since both claim the same files.
 *
 * Takes `fonts`, as `docxPagedRenderer.with({ fonts: [...] })`, and the layout depends
 * on them: a browser has nothing like Calibri, and text set in it otherwise falls back
 * to Source Sans, whose different widths move every line break after the first. Needs
 * a cross-origin isolated page, and fetches its own wasm module (separate from the PDF
 * one, about 5.7 MB gzipped) the first time a document is opened — unless given
 * another engine, as `docxPagedRenderer.with({ engine })` with
 * `@build-qube/papyra-tauri`'s `TauriOfficeEngine`. Experimental: the
 * engine is young, and a real document may lay out differently from Word.
 */
export const docxPagedRenderer = defineRenderer({
  id: 'docx-paged',
  label: 'Word',
  extensions: ['.docx', '.docm', '.dotx', '.dotm'],
  mimes: [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.template',
    'application/vnd.ms-word.document.macroenabled.12',
    'application/vnd.ms-word.template.macroenabled.12',
  ],
  load: () =>
    import('./file-preview-office-view').then((m) => m.OfficeFileView),
});
