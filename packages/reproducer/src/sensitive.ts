/**
 * Defense-in-depth gate for values about to be emitted into generated code.
 * Even if a persisted fixture marks a value "safe", never emit secrets.
 */

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const BEARER_RE = /bearer\s+[A-Za-z0-9._~+/-]{12,}/i;

function toLowerAscii(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

function isAsciiLetter(code: number): boolean {
  const lower = toLowerAscii(code);
  return lower >= 0x61 && lower <= 0x7a;
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/**
 * Identifier chars allowed between the secret prefix and the separator:
 * `-`, `_`, ASCII letters and ASCII digits (old `[-_a-z0-9]` + `/i`).
 */
function isSecretSuffixChar(code: number): boolean {
  return (
    code === 0x2d || code === 0x5f || isAsciiLetter(code) || isAsciiDigit(code)
  );
}

/** Credential chars: exactly the old `[A-Za-z0-9._~+/-]` class. */
function isSecretTokenChar(code: number): boolean {
  return (
    isAsciiLetter(code) ||
    isAsciiDigit(code) ||
    code === 0x2e || // .
    code === 0x5f || // _
    code === 0x7e || // ~
    code === 0x2b || // +
    code === 0x2f || // /
    code === 0x2d // -
  );
}

function isSecretSeparator(code: number): boolean {
  return code === 0x3a || code === 0x3d; // : =
}

/**
 * JavaScript `\s` for non-unicode matching: WhiteSpace plus LineTerminator
 * code units. Covers space, tab, LF, VT, FF, CR and the Unicode spaces the
 * old `\s*` accepted.
 */
function isSecretWhitespace(code: number): boolean {
  switch (code) {
    case 0x09: // \t
    case 0x0a: // \n
    case 0x0b: // \v
    case 0x0c: // \f
    case 0x0d: // \r
    case 0x20: // space
    case 0xa0:
    case 0x1680:
    case 0x2028:
    case 0x2029:
    case 0x202f:
    case 0x205f:
    case 0x3000:
    case 0xfeff:
      return true;
    default:
      return code >= 0x2000 && code <= 0x200a;
  }
}

/** Longest secret prefix (`api[_-]key`); bounds the resume overlap. */
const MAX_SECRET_PREFIX_LEN = 7;
/** Shortest full match: 2-char prefix + separator + 16-char token. */
const MIN_SECRET_MATCH_LEN = 19;
/** Credential tail length threshold (old `{16,}`). */
const SECRET_TOKEN_MIN_LEN = 16;

/**
 * Length of the secret prefix starting at `start` (0 when none matches).
 * Mirrors `(?:sk|pk|rk|api[_-]?key|secret|token)` case-insensitively.
 */
function matchSecretPrefixLen(
  value: string,
  start: number,
  end: number,
): number {
  const first = toLowerAscii(value.charCodeAt(start));
  if (first === 0x73) {
    // "sk" or "secret"
    if (start + 1 < end) {
      const second = toLowerAscii(value.charCodeAt(start + 1));
      if (second === 0x6b) {
        return 2;
      }
      if (
        second === 0x65 &&
        start + 5 < end &&
        toLowerAscii(value.charCodeAt(start + 2)) === 0x63 &&
        toLowerAscii(value.charCodeAt(start + 3)) === 0x72 &&
        toLowerAscii(value.charCodeAt(start + 4)) === 0x65 &&
        toLowerAscii(value.charCodeAt(start + 5)) === 0x74
      ) {
        return 6;
      }
    }
    return 0;
  }
  if (first === 0x70) {
    // "pk"
    if (start + 1 < end && toLowerAscii(value.charCodeAt(start + 1)) === 0x6b) {
      return 2;
    }
    return 0;
  }
  if (first === 0x72) {
    // "rk"
    if (start + 1 < end && toLowerAscii(value.charCodeAt(start + 1)) === 0x6b) {
      return 2;
    }
    return 0;
  }
  if (first === 0x74) {
    // "token"
    if (
      start + 4 < end &&
      toLowerAscii(value.charCodeAt(start + 1)) === 0x6f &&
      toLowerAscii(value.charCodeAt(start + 2)) === 0x6b &&
      toLowerAscii(value.charCodeAt(start + 3)) === 0x65 &&
      toLowerAscii(value.charCodeAt(start + 4)) === 0x6e
    ) {
      return 5;
    }
    return 0;
  }
  if (first === 0x61) {
    // "api[_-]?key"
    if (
      start + 2 < end &&
      toLowerAscii(value.charCodeAt(start + 1)) === 0x70 &&
      toLowerAscii(value.charCodeAt(start + 2)) === 0x69
    ) {
      if (
        start + 5 < end &&
        toLowerAscii(value.charCodeAt(start + 3)) === 0x6b &&
        toLowerAscii(value.charCodeAt(start + 4)) === 0x65 &&
        toLowerAscii(value.charCodeAt(start + 5)) === 0x79
      ) {
        return 6;
      }
      const sep = value.charCodeAt(start + 3);
      if (
        (sep === 0x5f || sep === 0x2d) &&
        start + 6 < end &&
        toLowerAscii(value.charCodeAt(start + 4)) === 0x6b &&
        toLowerAscii(value.charCodeAt(start + 5)) === 0x65 &&
        toLowerAscii(value.charCodeAt(start + 6)) === 0x79
      ) {
        return 7;
      }
    }
    return 0;
  }
  return 0;
}

/**
 * Linear secret-token detector replacing the old polynomial `LONG_TOKEN_RE`.
 *
 * Recognizes `PREFIX SUFFIX* WS* (":" | "=") WS* TOKEN{16,}` with an
 * unanchored search, case-insensitive prefixes (`sk`, `pk`, `rk`,
 * `api_key`/`api-key`/`apikey`, `secret`, `token`), ASCII identifier suffix
 * chars, JS `\s` whitespace, and the exact old credential alphabet
 * `[A-Za-z0-9._~+/-]` with the exact 16-char threshold.
 *
 * The scan is O(n): every position is examined a constant number of times.
 * Separator, whitespace and credential runs never overlap between candidate
 * starts (their alphabets are disjoint), and a failed candidate resumes just
 * before the end of its dead run because every start covered by that run
 * fails identically. No regex, no backtracking, no per-step allocation.
 *
 * Intentionally at least as protective as the old regex: incidental
 * whitespace between the identifier and the separator (e.g.
 * `"api-key = <token>"`) is also accepted, while every value the old
 * expression matched still matches.
 */
export function containsLongTokenLikeSecret(value: string): boolean {
  const n = value.length;
  let i = 0;
  while (i < n) {
    if (n - i < MIN_SECRET_MATCH_LEN) {
      return false;
    }
    const prefixLen = matchSecretPrefixLen(value, i, n);
    if (prefixLen === 0) {
      i += 1;
      continue;
    }
    let j = i + prefixLen;
    while (j < n && isSecretSuffixChar(value.charCodeAt(j))) {
      j += 1;
    }
    while (j < n && isSecretWhitespace(value.charCodeAt(j))) {
      j += 1;
    }
    if (j >= n) {
      // No separator can appear later; every later start has even less room.
      return false;
    }
    if (!isSecretSeparator(value.charCodeAt(j))) {
      // Dead run with no separator: every start covered by it fails the same
      // way, so resume just before its end (longest prefix minus one).
      const resume = j - (MAX_SECRET_PREFIX_LEN - 1);
      i = resume > i ? resume : i + 1;
      continue;
    }
    let k = j + 1;
    while (k < n && isSecretWhitespace(value.charCodeAt(k))) {
      k += 1;
    }
    let seen = 0;
    while (
      k < n &&
      seen < SECRET_TOKEN_MIN_LEN &&
      isSecretTokenChar(value.charCodeAt(k))
    ) {
      k += 1;
      seen += 1;
    }
    if (seen >= SECRET_TOKEN_MIN_LEN) {
      return true;
    }
    // The same separator would be reused by starts inside this candidate, so
    // skip them; anything at or past it is still examined normally.
    const resume = j - (MAX_SECRET_PREFIX_LEN - 1);
    i = resume > i ? resume : i + 1;
  }
  return false;
}
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
  if (containsLongTokenLikeSecret(value)) return true;
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
