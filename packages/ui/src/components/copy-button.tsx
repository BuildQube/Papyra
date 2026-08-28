'use client';

import { Button } from '@workspace/ui/components/button';
import { cn } from '@workspace/ui/lib/utils';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** How long the tick stays up before the icon returns to the clipboard. */
const CONFIRM_MS = 1600;

/** Props for {@link CopyButton}. */
export interface CopyButtonProps
  extends Omit<React.ComponentProps<typeof Button>, 'onClick' | 'children'> {
  /** The text written to the clipboard. */
  value: string;
  /**
   * Accessible name, and the `title`. Defaults to "Copy"; give it something
   * specific when several sit on one page.
   */
  label?: string;
}

/**
 * Copies a string, and says so.
 *
 * The confirmation is the whole point: a clipboard write is silent, so without the
 * tick the only feedback is pasting somewhere else and finding out. The timer is
 * cleared on unmount because the tick outlives a fast navigation otherwise, and
 * setting state on a gone component is a warning nobody needs.
 *
 * `navigator.clipboard` is unavailable on an insecure origin and can be refused by
 * permissions policy, so a failure leaves the icon alone rather than claiming a
 * success that did not happen.
 */
export function CopyButton({
  value,
  label = 'Copy',
  variant = 'ghost',
  size = 'icon-sm',
  className,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      aria-label={label}
      title={label}
      className={cn('shrink-0', className)}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), CONFIRM_MS);
          },
          () => {
            // Nothing reached the clipboard, so say nothing.
          },
        );
      }}
      {...props}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}
