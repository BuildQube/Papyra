import { WorkbookView } from '@/components/file-preview-sheet';
import type { FileViewProps } from '@/lib/file-preview-core';

/**
 * An Excel or OpenDocument spreadsheet, a sheet at a time.
 *
 * Loaded by `spreadsheetRenderer` — import that, not this, so papyra stays out of
 * the bundle until a spreadsheet is opened.
 */
export function SpreadsheetFileView({ file }: FileViewProps) {
  return <WorkbookView className="min-h-0 flex-1" file={file} />;
}
