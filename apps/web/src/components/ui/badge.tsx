import { cva, type VariantProps } from 'class-variance-authority';
import type * as React from 'react';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset',
  {
    variants: {
      variant: {
        default: 'bg-muted text-muted-foreground ring-border',
        outline: 'text-foreground ring-border',
        success: 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-400',
        danger: 'bg-rose-500/10 text-rose-700 ring-rose-500/25 dark:text-rose-400',
        amber: 'bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-400',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { badgeVariants };
