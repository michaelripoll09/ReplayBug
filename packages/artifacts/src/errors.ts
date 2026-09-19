/**
 * Typed errors for `@replaybug/artifacts`.
 *
 * Every failure carries a stable machine-readable `code` so RS-06 (upload
 * pipeline) and RS-08 (worker symbolication) can map outcomes without
 * parsing messages. Error messages never include file bytes or secrets;
 * storage keys are server-generated identifiers (project/release/hash),
 * not credentials, and are safe to attach for per-artifact diagnostics.
 */

export class ArtifactError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ArtifactError";
    this.code = code;
  }
}

/** A storage key failed validation (shape, charset, traversal, length). */
export class ArtifactKeyError extends ArtifactError {
  readonly key: string;

  constructor(key: string, message = "Invalid artifact storage key") {
    super("ARTIFACT_KEY_INVALID", `${message} (key length ${key.length})`);
    this.name = "ArtifactKeyError";
    this.key = key;
  }
}

/** The key is well-formed but no blob exists at that address. */
export class ArtifactNotFoundError extends ArtifactError {
  readonly key: string;

  constructor(key: string) {
    super("ARTIFACT_NOT_FOUND", "Artifact not found");
    this.name = "ArtifactNotFoundError";
    this.key = key;
  }
}

/** The underlying filesystem operation failed (permissions, disk, IO). */
export class ArtifactStorageError extends ArtifactError {
  constructor(message: string, options?: ErrorOptions) {
    super("ARTIFACT_STORAGE_ERROR", message, options);
    this.name = "ArtifactStorageError";
  }
}

/** The configured artifact root is missing or unsafe. */
export class ArtifactConfigError extends ArtifactError {
  constructor(message: string) {
    super("ARTIFACT_CONFIG_INVALID", message);
    this.name = "ArtifactConfigError";
  }
}

/** A bounded load exceeded its byte cap (source-map loading guard). */
export class ArtifactTooLargeError extends ArtifactError {
  readonly key: string;
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(key: string, sizeBytes: number, maxBytes: number) {
    super(
      "ARTIFACT_TOO_LARGE",
      `Artifact exceeds the ${maxBytes}-byte load cap`,
    );
    this.name = "ArtifactTooLargeError";
    this.key = key;
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

/**
 * A user-supplied `artifactPath` failed canonicalization (traversal,
 * absolute/drive/UNC shape, reserved name, control chars, bad encoding,
 * over-long input, or containment escape). The API maps this to
 * 400 ARTIFACT_PATH_INVALID.
 */
export class ArtifactPathError extends ArtifactError {
  constructor(message = "Invalid artifact path") {
    super("ARTIFACT_PATH_INVALID", message);
    this.name = "ArtifactPathError";
  }
}

/**
 * A `.map` upload failed Source Map v3 validation. The API maps this to
 * 400 INVALID_SOURCE_MAP with nothing persisted.
 */
export class InvalidSourceMapError extends ArtifactError {
  constructor(message = "Invalid source map") {
    super("INVALID_SOURCE_MAP", message);
    this.name = "InvalidSourceMapError";
  }
}

/**
 * An upload failed extension/MIME/type/content policy (not in the JS
 * symbolication allowlist, mismatched artifact type, or prohibited
 * executable/markup content). The API maps this to 400
 * INVALID_ARTIFACT_TYPE.
 */
export class InvalidArtifactTypeError extends ArtifactError {
  constructor(message = "Invalid artifact type") {
    super("INVALID_ARTIFACT_TYPE", message);
    this.name = "InvalidArtifactTypeError";
  }
}
