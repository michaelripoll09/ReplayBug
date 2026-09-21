/**
 * Deterministic tag slug normalization.
 *
 * Mirrors `normalizeProjectSlug` semantics so every project-local tag name
 * maps to exactly one stable slug: the `unique(project_id, slug)` constraint
 * then deduplicates equivalent spellings ("Needs Triage" vs "needs_triage").
 * Returns "" when nothing usable remains; callers reject empty slugs.
 */
export function normalizeTagSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}
