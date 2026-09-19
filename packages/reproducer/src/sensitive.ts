/**
 * Defense-in-depth gate for values about to be emitted into generated code.
 * Even if a persisted fixture marks a value "safe", never emit secrets.
 */

const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
const BEARER_RE = /bearer\s+[A-Za-z0-9._~+/-]{12,}/i;
// Long hex/base64-ish token shapes are suspicious in input values.
const LONG_TOKEN_RE =
  /(?:sk|pk|rk|api[_-]?key|secret|token)[-_a-z0-9]*[:=]\s*[A-Za-z0-9._~+/-]{16,}/i;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/;

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
  // Card-like digit runs (strip spaces/dashes first, check 13-19 digits).
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length >= 13 && digits.length <= 19 && CARD_RE.test(value)) {
    return true;
  }
  return false;
}
