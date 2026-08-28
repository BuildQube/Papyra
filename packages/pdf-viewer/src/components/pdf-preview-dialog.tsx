import type { Document } from '@build-qube/papyra';
import type { ReactElement } from 'react';
import { PdfViewerBasic } from '@/components/pdf-viewer-basic';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

/** Props for {@link PdfPreviewDialog}. */
export interface PdfPreviewDialogProps {
  /** The open document. */
  doc: Document;
  /** The heading. Usually the file name. */
  title: string;
  /** A line under the heading — a size, a date, whatever the app knows. */
  description?: string;
  /**
   * What opens the dialog — a single element, since it is rendered *as* the trigger
   * rather than inside one. Omit it to drive `open` yourself.
   */
  trigger?: ReactElement;
  /** Controlled open state. */
  open?: boolean;
  /** Called when the dialog opens or closes. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * A document in a dialog, for previewing one without leaving the page.
 *
 * The attachment case: a row in a list, a paperclip in a message, a file just
 * uploaded. It wraps {@link PdfViewerBasic} rather than the full viewer because a
 * dialog is a glance — a sidebar and a scrolling column are for reading, which is
 * what a real viewer route is for.
 *
 * ```tsx
 * <PdfPreviewDialog doc={doc} title={file.name} trigger={<Button>Preview</Button>} />
 * ```
 */
export function PdfPreviewDialog({
  doc,
  title,
  description,
  trigger,
  open,
  onOpenChange,
}: PdfPreviewDialogProps) {
  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      {trigger && <DialogTrigger render={trigger} />}
      {/*
       * Taller and wider than the default: a dialog sized for a form shows a page as
       * a postage stamp. The viewer fills whatever is left after the header.
       */}
      <DialogContent className="flex h-[80vh] max-h-[--spacing(180)] flex-col sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="truncate">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <PdfViewerBasic
          className="min-h-0 flex-1 overflow-hidden rounded-md border"
          doc={doc}
        />
      </DialogContent>
    </Dialog>
  );
}
