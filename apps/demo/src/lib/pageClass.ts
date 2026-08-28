/**
 * How a rendered page sits on the workspace: white, capped to the container, lifted
 * off the background. Shared because the viewer and the export view render the *same*
 * page surface on purpose — the only difference between them is how the pixels get
 * there, so a second copy of this would be a way for them to drift.
 */
export const PAGE =
  'h-auto max-w-full bg-white shadow-[0_6px_28px_rgb(0_0_0/0.5)]';
