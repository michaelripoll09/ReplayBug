import {
  REPRODUCTION_BASE_URL_REQUIRED,
  REPRODUCTION_INVALID_EVIDENCE,
  REPRODUCTION_UNSUPPORTED_FAILURE,
  ReproductionError,
  sanitizeRoute,
  validateBaseUrl,
} from "./base-url.js";
import { safeCommentFragment, tsSingleQuoteLiteral } from "./escaping.js";
import { selectLocator, type LocatorCandidate } from "./locators.js";
import { normalizeObservedMessage } from "./normalize.js";
import { looksSensitiveValue } from "./sensitive.js";
import { REPRODUCTION_GENERATOR_VERSION } from "./version.js";
import type {
  FailureEvidence,
  GenerationInput,
  ReproductionAction,
  ReproductionAssertion,
  ReproductionPlan,
  TimelineEvidenceItem,
} from "./types.js";

const MAX_TIMELINE_ITEMS = 50;
const MAX_ACTIONS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asCandidates(value: unknown): LocatorCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: LocatorCandidate[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const type = asString(item["type"]);
    const v = asString(item["value"]);
    const conf = item["confidence"];
    if (type === undefined || v === undefined || typeof conf !== "number")
      continue;
    out.push({ type, value: v, confidence: conf });
  }
  return out.slice(0, 5);
}

function breadcrumbKey(item: TimelineEvidenceItem): string {
  // Deterministic dedup key across standalone events + embedded rings.
  const p = item.payload;
  const parts = [item.eventType, item.sequenceNumber];
  for (const k of ["to_url", "from_url", "url", "method", "status_code"]) {
    const v = p[k];
    if (typeof v === "string" || typeof v === "number") parts.push(`${k}=${v}`);
  }
  const loc = p["locator_candidates"];
  if (Array.isArray(loc)) {
    const vals = loc
      .filter(isRecord)
      .map((c) => `${String(c["type"])}:${String(c["value"])}`)
      .sort();
    parts.push(`loc=${vals.join("|")}`);
  }
  const iname = p["input_name"] ?? p["input_id"];
  if (typeof iname === "string") parts.push(`in=${iname}`);
  return parts.join(";");
}

/**
 * Build a deterministic reproduction plan from sanitized evidence.
 * Throws ReproductionError with machine-readable codes for:
 * missing base URL, unsupported failure, invalid evidence.
 */
export function buildReproductionPlan(
  input: GenerationInput,
): ReproductionPlan {
  if (input.baseUrl.trim() === "") {
    throw new ReproductionError(
      REPRODUCTION_BASE_URL_REQUIRED,
      "Configure the base URL for this environment before generating a test.",
    );
  }
  const { origin } = validateBaseUrl(input.baseUrl);

  const assertion = toAssertion(input.failure);
  const ordered = [...input.timeline].sort(
    (a, b) =>
      a.sequenceNumber - b.sequenceNumber ||
      (a.occurredAt < b.occurredAt
        ? -1
        : a.occurredAt > b.occurredAt
          ? 1
          : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // Bound: most recent meaningful window, preserving initial nav context.
  let windowed = ordered.slice(-MAX_TIMELINE_ITEMS);
  const firstNavIndex = windowed.findIndex((e) => e.eventType === "navigation");
  // If we sliced away the first navigation but one exists earlier, pull
  // the earliest navigation in as startRoute context.
  let prefixNav: TimelineEvidenceItem | undefined;
  if (firstNavIndex === -1) {
    for (let i = ordered.length - windowed.length - 1; i >= 0; i--) {
      const ev = ordered[i];
      if (ev !== undefined && ev.eventType === "navigation") {
        prefixNav = ev;
        break;
      }
    }
  }
  const effective: TimelineEvidenceItem[] = prefixNav
    ? [prefixNav, ...windowed]
    : windowed;
  windowed = effective.slice(-MAX_TIMELINE_ITEMS);

  const seen = new Set<string>();
  const diagnostics: string[] = [];
  const warnings: string[] = [];
  const actions: ReproductionAction[] = [];
  let noLocatorRedacted = false;
  let startRoute: string | null = null;
  let lastClickIndex = -1;

  // Dedup embedded breadcrumb duplicates: collect breadcrumb signatures
  // from failure-adjacent events so we don't emit actions twice.
  const embeddedSignatures = new Set<string>();
  for (const item of windowed) {
    for (const b of item.breadcrumbs ?? []) {
      if (!isRecord(b)) continue;
      const t = asString(b["type"]) ?? asString(b["event_type"]) ?? "";
      const d = isRecord(b["data"]) ? b["data"] : {};
      const url = asString(d["to_url"]) ?? asString(d["url"]) ?? "";
      embeddedSignatures.add(`${t};${url}`);
    }
  }

  windowed.forEach((item, index) => {
    const key = breadcrumbKey(item);
    if (seen.has(key)) {
      return; // deterministic dedup: standalone + embedded, retries
    }
    // Input+change pairs share the same input identity: consecutive fills
    // on the same locator collapse to the last one (final value wins).
    // Legitimately repeated fills separated by other actions are preserved.
    if (item.eventType === "input") {
      const probe = peekInputLocatorKey(item.payload);
      const lastAction = actions[actions.length - 1];
      if (
        probe !== null &&
        lastAction !== undefined &&
        lastAction.kind === "fill" &&
        fillLocatorKey(lastAction) === probe
      ) {
        actions.pop();
        // lastClickIndex unchanged (fill is not a click).
      }
    }
    seen.add(key);

    switch (item.eventType) {
      case "navigation": {
        const toUrl = asString(item.payload["to_url"]);
        if (toUrl === undefined) {
          diagnostics.push("ReplayBug observed a navigation without a target.");
          return;
        }
        const route = sanitizeRoute(toUrl);
        if (route === null) {
          warnings.push(
            `Unsafe navigation target omitted: ${safeCommentFragment(toUrl, 120)}`,
          );
          diagnostics.push(
            "ReplayBug observed a navigation target that could not be safely reproduced.",
          );
          return;
        }
        if (startRoute === null) {
          startRoute = route;
          return; // first usable navigation establishes startRoute
        }
        // Navigation directly following a captured click is usually an
        // observed effect: assert URL instead of a redundant goto.
        if (lastClickIndex === actions.length - 1 && index > 0) {
          actions.push({ kind: "expectUrl", route });
        } else {
          // Explicit later navigation with no causal click: goto/waitForURL.
          actions.push({ kind: "navigate", route });
        }
        return;
      }
      case "click": {
        const locator = selectLocator(
          asCandidates(item.payload["locator_candidates"]),
        );
        if (locator === null) {
          diagnostics.push(
            "ReplayBug observed a click without a usable locator; manual selection is required.",
          );
          warnings.push("Click without usable locator skipped.");
          return;
        }
        const label =
          asString(item.payload["accessible_name"]) ??
          asString(item.payload["route"]);
        if (locator.brittle) {
          warnings.push(
            `Brittle locator used for click: ${safeCommentFragment(locator.expression, 160)}`,
          );
        }
        actions.push({
          kind: "click",
          locatorExpression: locator.expression,
          strategy: locator.strategy,
          brittle: locator.brittle,
          ...(label !== undefined ? { label } : {}),
        });
        lastClickIndex = actions.length - 1;
        return;
      }
      case "input": {
        const inputType = asString(item.payload["input_type"]) ?? "text";
        void inputType;
        const inputName =
          asString(item.payload["input_name"]) ??
          asString(item.payload["input_id"]);
        const hasValue = item.payload["has_value"] === true;
        const rawValue = asString(item.payload["value"]);
        // Locator for inputs: SDK input events don't carry candidates in
        // the current contract; derive from input_name/id when stable.
        const derived = deriveInputLocator(item.payload);
        if (derived === null) {
          if (hasValue || rawValue !== undefined) noLocatorRedacted = true;
          diagnostics.push(
            "ReplayBug observed an input without a stable locator; fill it manually with a test value.",
          );
          warnings.push("Input without locator requires manual intervention.");
          return;
        }
        if (
          rawValue !== undefined &&
          !looksSensitiveValue(rawValue, inputName ?? "")
        ) {
          actions.push({
            kind: "fill",
            locatorExpression: derived.expression,
            strategy: derived.strategy,
            value: rawValue,
            redacted: false,
            ...(inputName !== undefined ? { inputName } : {}),
          });
          return;
        }
        // Redacted / unavailable value: explicit placeholder, never guess.
        actions.push({
          kind: "fill",
          locatorExpression: derived.expression,
          strategy: derived.strategy,
          redacted: true,
          ...(inputName !== undefined ? { inputName } : {}),
        });
        return;
      }
      case "network":
      case "console":
      case "custom_breadcrumb":
      case "sdk":
      case "message": {
        const diag = diagnosticComment(item);
        if (diag !== null) diagnostics.push(diag);
        return;
      }
      default: {
        const diag = diagnosticComment(item);
        if (diag !== null) diagnostics.push(diag);
        return;
      }
    }
  });

  if (startRoute === null) {
    // Fall back to the occurrence page route when no navigation evidence.
    const occurrence = windowed[windowed.length - 1];
    const fallback =
      occurrence?.pageUrl !== undefined
        ? sanitizeRoute(occurrence.pageUrl)
        : null;
    startRoute = fallback ?? "/";
    diagnostics.push("ReplayBug used the occurrence page as the start route.");
  }

  if (actions.length > MAX_ACTIONS) {
    throw new ReproductionError(
      REPRODUCTION_INVALID_EVIDENCE,
      "Timeline produces too many actions.",
    );
  }

  // Keep diagnostics bounded + deterministic.
  const boundedDiagnostics = diagnostics.slice(0, 20);
  // Redaction is derived from the final action list so collapsing an
  // input+change pair cannot leave a stale flag behind.
  const hasRedactedSteps =
    noLocatorRedacted || actions.some((a) => a.kind === "fill" && a.redacted);

  return {
    generatorVersion: REPRODUCTION_GENERATOR_VERSION,
    issueId: input.issueId,
    issueTitle: input.issueTitle,
    occurrenceEventId: input.occurrenceEventId,
    environment: input.environment,
    ...(input.release !== undefined ? { release: input.release } : {}),
    baseUrl: origin,
    startRoute,
    actions: actions.slice(0, MAX_ACTIONS),
    diagnostics: boundedDiagnostics,
    assertion,
    warnings: warnings.slice(0, 20),
    hasRedactedSteps,
  };
}

function fillLocatorKey(action: { locatorExpression: string }): string {
  return action.locatorExpression;
}

function peekInputLocatorKey(payload: Record<string, unknown>): string | null {
  const derived = deriveInputLocator(payload);
  return derived === null ? null : derived.expression;
}

function deriveInputLocator(
  payload: Record<string, unknown>,
): { expression: string; strategy: string } | null {
  const name = asString(payload["input_name"]);
  const id = asString(payload["input_id"]);
  // Prefer stable id, then name attribute.
  if (id !== undefined && id !== "" && !/[\s>"']/.test(id)) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) || /^\d{10,}$/.test(id)) {
      // fall through to name
    } else {
      return {
        expression: `page.locator(${tsSingleQuoteLiteral(`#${id}`)})`,
        strategy: "id",
      };
    }
  }
  if (name !== undefined && name !== "" && !/[\s>"']/.test(name)) {
    const attr = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return {
      expression: `page.locator(${tsSingleQuoteLiteral(`[name="${attr}"]`)})`,
      strategy: "name",
    };
  }
  const candidates = asCandidates(payload["locator_candidates"]);
  if (candidates.length > 0) {
    const sel = selectLocator(candidates);
    if (sel) return { expression: sel.expression, strategy: sel.strategy };
  }
  return null;
}

function diagnosticComment(item: TimelineEvidenceItem): string | null {
  const p = item.payload;
  switch (item.eventType) {
    case "network": {
      const method = asString(p["method"]) ?? "GET";
      const url = asString(p["url"]) ?? "";
      const status = p["status_code"];
      const route = url !== "" ? sanitizeRoute(url) : null;
      const shown =
        route ?? safeCommentFragment(url.slice(0, 160), 160) ?? "unknown URL";
      return `ReplayBug observed a failed ${safeCommentFragment(method, 16)} ${shown} → ${typeof status === "number" ? status : "network error"}.`;
    }
    case "console":
    case "console_error": {
      const args = Array.isArray(p["args"])
        ? p["args"]
            .filter((a): a is string => typeof a === "string")
            .slice(0, 2)
        : [];
      const first =
        args[0] !== undefined
          ? normalizeObservedMessage(args[0]).slice(0, 160)
          : "console error";
      return `ReplayBug observed console error before the failure: ${safeCommentFragment(first, 160)}.`;
    }
    case "custom_breadcrumb":
    case "message":
    case "sdk": {
      const msg =
        asString(p["message"]) ?? asString(p["category"]) ?? item.eventType;
      return `ReplayBug observed ${safeCommentFragment(msg, 160)}.`;
    }
    default:
      return null;
  }
}

function toAssertion(failure: FailureEvidence): ReproductionAssertion {
  switch (failure.kind) {
    case "exception":
    case "unhandled_rejection": {
      if (
        (failure.expectedMessage ?? "") === "" &&
        (failure.expectedType ?? "") === ""
      ) {
        throw new ReproductionError(
          REPRODUCTION_UNSUPPORTED_FAILURE,
          "Failure evidence has no assertable message or type.",
        );
      }
      return {
        kind: "pageerror",
        ...(failure.expectedType !== undefined
          ? { expectedType: failure.expectedType }
          : {}),
        ...(failure.expectedMessage !== undefined
          ? { expectedMessage: failure.expectedMessage }
          : {}),
      };
    }
    case "console_error": {
      const expectedMessage = failure.expectedMessage;
      if ((expectedMessage ?? "") === "") {
        throw new ReproductionError(
          REPRODUCTION_UNSUPPORTED_FAILURE,
          "Console failure has no assertable text.",
        );
      }
      return {
        kind: "console_error",
        expectedMessage: expectedMessage as string,
      };
    }
    case "network": {
      if ((failure.method ?? "") === "" || (failure.url ?? "") === "") {
        throw new ReproductionError(
          REPRODUCTION_UNSUPPORTED_FAILURE,
          "Network failure lacks method or URL.",
        );
      }
      const route = normalizeRouteForAssertion(failure.url ?? "");
      if (route === null) {
        throw new ReproductionError(
          REPRODUCTION_UNSUPPORTED_FAILURE,
          "Network failure URL is not assertable.",
        );
      }
      if (
        failure.statusCode === null &&
        (failure.failureCategory ?? "") === ""
      ) {
        // Actual network-error/no-response without a deterministic
        // Playwright signal: refuse to emit a false test.
        throw new ReproductionError(
          REPRODUCTION_UNSUPPORTED_FAILURE,
          "Network error without status is not deterministically observable.",
        );
      }
      return {
        kind: "network",
        method: failure.method ?? "GET",
        route,
        ...(failure.statusCode !== undefined
          ? { statusCode: failure.statusCode }
          : {}),
        ...(failure.failureCategory !== undefined
          ? { failureCategory: failure.failureCategory }
          : {}),
      };
    }
  }
}

function normalizeRouteForAssertion(url: string): string | null {
  // Reuse sanitizeRoute then strip query.
  const route = sanitizeRoute(url);
  if (route === null) return null;
  const q = route.indexOf("?");
  return q === -1 ? route : route.slice(0, q);
}

export const __testHooks = {
  MAX_TIMELINE_ITEMS,
  diagnosticComment,
};
