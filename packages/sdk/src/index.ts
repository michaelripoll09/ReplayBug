/**
 * ReplayBug browser SDK — foundation metadata only.
 *
 * The full capture API (init, captureException, breadcrumbs, transport) is
 * intentionally out of scope for the repository bootstrap and will arrive
 * in a later block. This module exposes only honest, already-real metadata
 * so applications can depend on the package boundary without importing a
 * fake `init()` that pretends to capture telemetry.
 */

/** Current SDK package version. Kept in sync with package.json manually. */
export const SDK_VERSION = "0.1.0";

/** Telemetry protocol version the future SDK will speak. Reserved, not used yet. */
export const SDK_PROTOCOL_VERSION = 1;

/** Package name used in telemetry envelopes once capture is implemented. */
export const SDK_NAME = "@replaybug/sdk";
