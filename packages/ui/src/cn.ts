import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class lists with shadcn/ui-compatible semantics:
 * conditional inputs via clsx, conflicting utilities resolved via
 * tailwind-merge.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(...inputs));
}
