import { useId, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

/**
 * A small CSS tooltip. It wraps its trigger in a focusable span, so it also works for disabled buttons
 * (which receive no pointer or focus events themselves).
 */
export function Tooltip({
  content,
  children,
  className,
  align = 'center',
}: {
  content: string;
  children: ReactNode;
  className?: string;
  /** `end` keeps the tooltip inside the viewport for triggers at the right edge. */
  align?: 'center' | 'end';
}) {
  const id = useId();
  return (
    <span tabIndex={0} aria-describedby={id} className={cn('group/tooltip relative inline-flex rounded-md', className)}>
      {children}
      <span
        role="tooltip"
        id={id}
        className={cn(
          'pointer-events-none invisible absolute bottom-full z-50 mb-2 w-max max-w-60 rounded-md bg-foreground px-2 py-1 text-xs text-background opacity-0 shadow-md transition-opacity group-hover/tooltip:visible group-hover/tooltip:opacity-100 group-focus-visible/tooltip:visible group-focus-visible/tooltip:opacity-100',
          align === 'center' ? 'left-1/2 -translate-x-1/2' : 'right-0',
        )}
      >
        {content}
      </span>
    </span>
  );
}
