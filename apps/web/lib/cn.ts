import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Local class-name helper. Mirrors `@replaybug/ui`'s `cn` so the web app
 * keeps working even before the shared design system is installed, and acts
 * as the seam where a future shadcn/ui setup will consolidate.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(...inputs));
}
