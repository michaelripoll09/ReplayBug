/**
 * Normalization mirror for stable failure matching.
 * Mirrors the server's volatile-value normalization enough for generated
 * tests to compare observed vs expected messages without flaking on IDs.
 */

export function normalizeObservedMessage(value: string): string {
  return (
    value
      // UUIDs
      .replace(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
        ":id",
      )
      // Long hex ids
      .replace(/\b[0-9a-f]{16,64}\b/gi, ":id")
      // Long integer ids
      .replace(/\b\d{6,}\b/g, ":id")
      // ISO timestamps
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, ":time")
      // Query strings
      .replace(/\?[^\s'"]*/g, "?…")
      // Memory addresses
      .replace(/0x[0-9a-f]+/gi, ":addr")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000)
  );
}
