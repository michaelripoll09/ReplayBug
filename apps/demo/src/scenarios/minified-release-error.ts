/**
 * Minified release error scenario (Block 7, RS-11).
 *
 * Stable demo scenario for the release source-map flow. The throwing frame
 * lives in this file on purpose: after the production (minified) build, the
 * uploaded source maps must symbolicate the minified stack back to this
 * original `src/scenarios/minified-release-error.ts` path.
 *
 * The RS-12 production E2E creates the release `MINIFIED_RELEASE_VERSION`
 * via the CLI and serves the production build with `VITE_REPLAYBUG_RELEASE`
 * set to the same value, so the SDK release string matches exactly.
 */

/** Exact release string the RS-12 production E2E creates and runs with. */
export const MINIFIED_RELEASE_VERSION = "demo@1.0.0";

/** Scenario tag attached to the captured exception context. */
export const MINIFIED_RELEASE_SCENARIO_ID = "minified-release-error";

/** Stable button label; the RS-12 E2E locates the trigger by this text. */
export const MINIFIED_RELEASE_BUTTON_LABEL = "6. Minified Release Error";

/** Stable selector hook for the RS-12 E2E. */
export const MINIFIED_RELEASE_TEST_ID = "scenario-minified-release-error";

interface ReleaseLineItem {
  sku: string;
  quantity: number;
}

interface ReleaseOrder {
  id: string;
  lines: ReleaseLineItem[];
}

/**
 * Throws a genuine runtime TypeError from this file.
 *
 * Simulates a release API response that violates its contract and is null
 * at runtime. Reading `lines` of null throws; the throwing frame is this
 * module, which is the original-source target the symbolication flow must
 * recover from the minified production bundle.
 */
export function triggerMinifiedReleaseError(): never {
  const order = JSON.parse("null") as ReleaseOrder;
  const lineCount = order.lines.length;
  throw new Error(
    `DEMO: Minified release error is unreachable (lines=${lineCount})`,
  );
}
