import { WorkbookView } from '@/components/file-preview-sheet';
import type { FileViewProps } from '@/lib/file-preview-core';

/**
 * CSV or TSV as a grid, with the guessed encoding and delimiter on its status line.
 *
 * Loaded by `csvRenderer` — import that, not this, so papyra stays out of the bundle
 * until a CSV is opened.
 */
export function CsvFileView({ file }: FileViewProps) {
  return <WorkbookView className="min-h-0 flex-1" file={file} />;
}
