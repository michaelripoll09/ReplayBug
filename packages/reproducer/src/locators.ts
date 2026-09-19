/* eslint-disable no-control-regex -- intentional control-character handling for safe code generation */
import { stripControlChars, tsSingleQuoteLiteral } from "./escaping.js";

export type LocatorCandidateType =
  "test_id" | "role_name" | "label" | "id" | "name" | "css_fallback";

export interface LocatorCandidate {
  type: string;
  value: string;
  confidence: number;
}

export interface SelectedLocator {
  /** Playwright expression, e.g. page.getByTestId('x') */
  expression: string;
  strategy: LocatorCandidateType;
  brittle: boolean;
}

const CONTROL_RE = /[\u0000-\u001F\u007F\u2028\u2029]/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_NUMERIC_RE = /^\d{10,}$/;
const RANDOM_TOKEN_RE = /^[a-z0-9]{20,}$/i;
const GENERATED_CSS_RE = /(css-[a-z0-9]{4,}|sc-[a-z0-9]{4,}|_[a-z0-9]{6,})/i;

function candidateIsUnsafe(candidate: LocatorCandidate): boolean {
  if (candidate.value.length === 0 || candidate.value.length > 512) return true;
  if (CONTROL_RE.test(candidate.value)) return true;
  if (
    candidate.value.toLowerCase().includes("password") ||
    candidate.value.toLowerCase().includes("secret") ||
    candidate.value.toLowerCase().includes("bearer ") ||
    candidate.value.includes("[REDACTED]")
  ) {
    return true;
  }
  return false;
}

function isBrittleValue(type: string, value: string): boolean {
  if (value.includes(":nth-child") || value.includes(":nth-of-type")) {
    return true;
  }
  if (value.split(">").length > 4) return true;
  if (UUID_RE.test(value.replace(/^#/, ""))) return true;
  const idPart = value.replace(/^#/, "");
  if (LONG_NUMERIC_RE.test(idPart)) return true;
  if (RANDOM_TOKEN_RE.test(idPart) && idPart.length >= 20) return true;
  if (type === "css_fallback" && GENERATED_CSS_RE.test(value)) return true;
  if (value.length > 160) return true;
  return false;
}

function parseRoleName(value: string): { role: string; name: string } | null {
  // SDK format: role[name="accessibleName"]
  const m = /^([a-zA-Z][a-zA-Z-]*)\[name="([\s\S]*)"\]$/.exec(value);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const role = m[1];
  // Unescape SDK quoting (\" -> ").
  const name = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (role.length > 64 || name.length === 0 || name.length > 128) return null;
  if (CONTROL_RE.test(role) || CONTROL_RE.test(name)) return null;
  return { role, name };
}

/**
 * Select the strongest usable locator.
 * Priority: test_id > role_name > label > stable id > name > css_fallback,
 * confidence as secondary ranking. Never prefers a lower-confidence CSS
 * selector when a valid semantic candidate exists.
 */
export function selectLocator(
  candidates: LocatorCandidate[],
): SelectedLocator | null {
  const usable = candidates.filter((c) => !candidateIsUnsafe(c));
  if (usable.length === 0) return null;

  const rank: Record<string, number> = {
    test_id: 0,
    role_name: 1,
    label: 2,
    id: 3,
    name: 4,
    css_fallback: 5,
  };

  const sorted = [...usable].sort((a, b) => {
    const ra = rank[a.type] ?? 9;
    const rb = rank[b.type] ?? 9;
    if (ra !== rb) return ra - rb;
    return b.confidence - a.confidence;
  });

  // Prefer the first non-brittle candidate; fall back to brittle only
  // when nothing else is usable (caller emits a warning comment).
  for (const c of sorted) {
    const built = buildExpression(c);
    if (built === null) continue;
    const brittle = isBrittleValue(c.type, c.value);
    if (!brittle) return { ...built, brittle: false };
  }
  for (const c of sorted) {
    const built = buildExpression(c);
    if (built === null) continue;
    return { ...built, brittle: true };
  }
  return null;
}

function buildExpression(
  c: LocatorCandidate,
): Omit<SelectedLocator, "brittle"> | null {
  const clean = stripControlChars(c.value);
  if (clean === "") return null;
  switch (c.type) {
    case "test_id": {
      return {
        expression: `page.getByTestId(${tsSingleQuoteLiteral(clean)})`,
        strategy: "test_id",
      };
    }
    case "role_name": {
      const parsed = parseRoleName(clean);
      if (parsed === null) return null;
      return {
        expression: `page.getByRole(${tsSingleQuoteLiteral(parsed.role)}, { name: ${tsSingleQuoteLiteral(parsed.name)} })`,
        strategy: "role_name",
      };
    }
    case "label": {
      return {
        expression: `page.getByLabel(${tsSingleQuoteLiteral(clean)})`,
        strategy: "label",
      };
    }
    case "id": {
      const id = clean.startsWith("#") ? clean.slice(1) : clean;
      if (id === "" || /[\s>"']/.test(id)) return null;
      return {
        expression: `page.locator(${tsSingleQuoteLiteral(`#${id}`)})`,
        strategy: "id",
      };
    }
    case "name": {
      // SDK: tag[name="..."] — emit a stable attribute selector.
      const m = /^([a-z][a-z0-9-]*)?\[name="([\s\S]*)"\]$/i.exec(clean);
      if (m && m[2] !== undefined) {
        const tag = m[1] ?? "";
        const name = m[2].replace(/\\"/g, '"');
        if (CONTROL_RE.test(name)) return null;
        const selector =
          tag !== ""
            ? `${tag}[name=${tsSingleQuoteLiteral(name)}]`
            : `[name=${tsSingleQuoteLiteral(name)}]`;
        // tsSingleQuoteLiteral already quotes; build selector carefully:
        // use double-quote attr form with escaped value instead.
        void selector;
        const attrValue = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        const sel =
          tag !== "" ? `${tag}[name="${attrValue}"]` : `[name="${attrValue}"]`;
        return {
          expression: `page.locator(${tsSingleQuoteLiteral(sel)})`,
          strategy: "name",
        };
      }
      return null;
    }
    case "css_fallback": {
      if (clean.includes("<") || clean.includes(">") === false) {
        // css fallback must look like a selector; reject markup-ish junk
        if (/[<>]{2,}/.test(clean)) return null;
      }
      return {
        expression: `page.locator(${tsSingleQuoteLiteral(clean)})`,
        strategy: "css_fallback",
      };
    }
    default:
      return null;
  }
}
