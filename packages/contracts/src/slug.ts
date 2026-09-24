/**
 * Shared linear slug normalization.
 *
 * Preserves the exact semantics of the previous chained-regex pipeline
 * (trim, lowercase, spaces/whitespace/underscores to hyphen, drop characters
 * outside ASCII a-z/0-9/hyphen, collapse repeated hyphens, strip
 * leading/trailing hyphens) with an explicit O(n) single-pass algorithm and
 * no repeated-quantifier regular expressions.
 */

/** True for every character matched by `\s` (WhiteSpace + LineTerminator). */
function isSlugWhitespace(code: number): boolean {
  return (
    code === 0x09 || // \t
    code === 0x0a || // \n
    code === 0x0b || // \v
    code === 0x0c || // \f
    code === 0x0d || // \r
    code === 0x20 || // space
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

/**
 * Normalize a slug in linear time: trim, lowercase, map `_`/whitespace/`-`
 * runs to a single hyphen, drop every other non-`[a-z0-9-]` character, and
 * strip leading/trailing hyphens. Returns "" when nothing usable remains.
 */
export function normalizeSlugValue(input: string): string {
  const lowered = input.trim().toLowerCase();
  let out = "";
  let lastWasHyphen = true;
  for (const ch of lowered) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) {
      out += ch;
      lastWasHyphen = false;
    } else if (ch === "-" || ch === "_" || isSlugWhitespace(ch.charCodeAt(0))) {
      if (!lastWasHyphen) {
        out += "-";
        lastWasHyphen = true;
      }
    }
    // Every other character is dropped (matches `[^a-z0-9-]` removal).
  }
  if (lastWasHyphen && out.endsWith("-")) {
    out = out.slice(0, -1);
  }
  return out;
}
