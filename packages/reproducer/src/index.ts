export { REPRODUCTION_GENERATOR_VERSION } from "./version.js";
export { buildReproductionPlan } from "./plan.js";
export { renderPlaywrightTest } from "./render.js";
export { validateGeneratedSyntax } from "./syntax.js";
export {
  validateBaseUrl,
  sanitizeRoute,
  normalizeNetworkPath,
} from "./base-url.js";
export { selectLocator } from "./locators.js";
export { normalizeObservedMessage } from "./normalize.js";
export { looksSensitiveValue } from "./sensitive.js";
export {
  tsSingleQuoteLiteral,
  safeCommentFragment,
  stripControlChars,
} from "./escaping.js";
export {
  ReproductionError,
  REPRODUCTION_BASE_URL_REQUIRED,
  REPRODUCTION_UNSUPPORTED_FAILURE,
  REPRODUCTION_OUTPUT_TOO_LARGE,
  REPRODUCTION_INVALID_EVIDENCE,
} from "./base-url.js";
export type {
  GenerationInput,
  TimelineEvidenceItem,
  FailureEvidence,
  ReproductionPlan,
  ReproductionAction,
  ReproductionAssertion,
  GeneratedReproduction,
  GenerationLocatorCandidate,
} from "./types.js";
