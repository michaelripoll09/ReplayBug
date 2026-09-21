import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const alertVariants = cva("rounded-md border px-4 py-3 text-sm", {
  variants: {
    variant: {
      default:
        "border-zinc-200 bg-white text-zinc-950 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-50",
      destructive:
        "border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100",
      muted:
        "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
    },
  },
  defaultVariants: { variant: "default" },
});

export interface AlertProps
  extends
    React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof alertVariants> {
  title?: string | undefined;
}

export function Alert({
  className,
  variant,
  title,
  children,
  ...props
}: AlertProps): React.JSX.Element {
  return (
    <div
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    >
      {title !== undefined && title.length > 0 ? (
        <p className="font-medium">{title}</p>
      ) : null}
      {children !== undefined ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}
