import { TELEMETRY_LIMITS } from "@replaybug/contracts";
import type { Breadcrumb } from "./config.js";

/**
 * Ring buffer for breadcrumbs with O(1) append and chronological iteration.
 */
export class BreadcrumbBuffer {
  private buffer: (Breadcrumb | null)[];
  private capacity: number;
  private head = 0; // Next write position
  private size = 0; // Current number of elements
  private dropped = 0; // Count of dropped breadcrumbs (for debugging)

  constructor(capacity: number = TELEMETRY_LIMITS.MAX_BREADCRUMBS) {
    this.capacity = Math.max(1, capacity);
    this.buffer = new Array(this.capacity).fill(null);
  }

  /**
   * Add a breadcrumb to the buffer (O(1)).
   * Oldest breadcrumb is overwritten when full.
   */
  add(breadcrumb: Breadcrumb): void {
    this.buffer[this.head] = breadcrumb;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      this.dropped++;
    }
  }

  /**
   * Get all breadcrumbs in chronological order (oldest first).
   */
  getAll(): Breadcrumb[] {
    if (this.size === 0) return [];

    const result: Breadcrumb[] = new Array(this.size);
    const start = (this.head - this.size + this.capacity) % this.capacity;

    for (let i = 0; i < this.size; i++) {
      const idx = (start + i) % this.capacity;
      const crumb = this.buffer[idx];
      if (crumb != null) {
        result[i] = crumb;
      }
    }

    return result;
  }

  /**
   * Get the most recent N breadcrumbs.
   */
  getRecent(count: number): Breadcrumb[] {
    const all = this.getAll();
    return all.slice(-Math.min(count, all.length));
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.buffer.fill(null);
    this.head = 0;
    this.size = 0;
    this.dropped = 0;
  }

  /**
   * Get current size.
   */
  getSize(): number {
    return this.size;
  }

  /**
   * Get capacity.
   */
  getCapacity(): number {
    return this.capacity;
  }

  /**
   * Get count of dropped breadcrumbs (for debugging).
   */
  getDroppedCount(): number {
    return this.dropped;
  }

  /**
   * Reset dropped count.
   */
  resetDroppedCount(): void {
    this.dropped = 0;
  }
}

/**
 * Create a breadcrumb object
 */
export function createBreadcrumb(
  type: Breadcrumb["type"],
  data: Partial<Breadcrumb> = {},
): Breadcrumb {
  const breadcrumb: Breadcrumb = {
    timestamp: new Date().toISOString(),
    type,
    level: data.level ?? "info",
  };

  if (data.category !== undefined) breadcrumb.category = data.category;
  if (data.message !== undefined) breadcrumb.message = data.message;
  if (data.data !== undefined) breadcrumb.data = data.data;
  if (data.event_type !== undefined) breadcrumb.event_type = data.event_type;
  if (data.payload !== undefined) breadcrumb.payload = data.payload;

  return breadcrumb;
}
