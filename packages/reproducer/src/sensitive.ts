/**
 * Defense-in-depth gate for values about to be emitted into generated code.
 * Even if a persisted fixture marks a value "safe", never emit secrets.
 */

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const BEARER_RE = /bearer\s+[A-Za-z0-9._~+/-]{12,}/i;
// Long hex/base64-ish token shapes are suspicious in input values.
const LONG_TOKEN_RE =
  /(?:sk|pk|rk|api[_-]?key|secret|token)[-_a-z0-9]*[:=]\s*[A-Za-z0-9._~+/-]{16,}/i;
function isAsciiDigitChar(value: string): boolean {
  return value >= "0" && value <= "9";
}

function isWordChar(value: string): boolean {
  return (
    (value >= "a" && value <= "z") ||
    (value >= "A" && value <= "Z") ||
    (value >= "0" && value <= "9") ||
    value === "_"
  );
}

/**
 * Linear scan for card-like digit runs (13-19 digits, single spaces or
 * hyphens allowed between digits, word boundaries at both ends).
 *
 * Mirrors the previous `CARD_RE` match semantics: a run is a maximal
 * digit cluster joined by single separators (double separators or other
 * characters break the run, as before), candidate starts are the cluster
 * head (with the outer boundary check) plus every digit following a
 * separator, and every 13-19 digit prefix is accepted only with a
 * non-word/end boundary after its final digit. Never weaker than the
 * regex: every string the regex matched still matches.
 */
function containsCardLikeRun(value: string): boolean {
  const n = value.length;
  let i = 0;
  while (i < n) {
    while (i < n && !isAsciiDigitChar(value.charAt(i))) {
      i += 1;
    }
    if (i >= n) {
      return false;
    }
    // Extend the maximal cluster: digits joined by single separators.
    const digitEnds: number[] = [];
    let j = i;
    while (j < n) {
      const ch = value.charAt(j);
      if (isAsciiDigitChar(ch)) {
        j += 1;
        digitEnds.push(j);
      } else if (
        (ch === " " || ch === "-") &&
        j + 1 < n &&
        isAsciiDigitChar(value.charAt(j + 1))
      ) {
        j += 1;
      } else {
        break;
      }
    }
    // Candidate starts as digit ordinals: the cluster head (ordinal 0,
    // subject to the outer word-boundary check) plus every digit following
    // a separator (a separator is a non-word char, so `\b` always holds).
    const startOrdinals: number[] = [0];
    for (let d = 1; d < digitEnds.length; d += 1) {
      const digitPos = (digitEnds[d] ?? 1) - 1;
      const prev = value.charAt(digitPos - 1);
      if (prev === " " || prev === "-") {
        startOrdinals.push(d);
      }
    }
    const headOk = i === 0 || !isWordChar(value.charAt(i - 1));
    for (const ordinal of startOrdinals) {
      if (ordinal === 0 && !headOk) {
        continue;
      }
      const available = digitEnds.length - ordinal;
      for (let take = 13; take <= 19 && take <= available; take += 1) {
        const end = digitEnds[ordinal + take - 1] ?? n;
        if (end >= n || !isWordChar(value.charAt(end))) {
          return true;
        }
      }
    }
    i = j;
  }
  return false;
}

export function looksSensitiveValue(value: string, fieldHint = ""): boolean {
  const hint = fieldHint.toLowerCase();
  if (
    hint.includes("password") ||
    hint.includes("passwd") ||
    hint === "pwd" ||
    hint.includes("card") ||
    hint.includes("cvv") ||
    hint.includes("cvc") ||
    hint.includes("secret") ||
    hint.includes("token") ||
    hint.includes("bearer") ||
    hint.includes("authorization") ||
    hint.includes("cookie") ||
    hint.includes("api_key") ||
    hint.includes("apikey")
  ) {
    return true;
  }
  if (value.includes("[REDACTED]") || value.includes("�")) return true;
  if (JWT_RE.test(value)) return true;
  if (BEARER_RE.test(value)) return true;
  if (LONG_TOKEN_RE.test(value)) return true;
  // Card-like digit runs: 13-19 digits in the whole value with a bounded
  // card-like run present (linear scan, at least as strong as before).
  const digits = value.replace(/[^0-9]/g, "");
  if (
    digits.length >= 13 &&
    digits.length <= 19 &&
    containsCardLikeRun(value)
  ) {
    return true;
  }
  return false;
}
