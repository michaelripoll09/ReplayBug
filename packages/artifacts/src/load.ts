/**
 * Bounded load-bytes helpers (RS-05).
 *
 * Deliberately small: stream an artifact fully into memory under a byte
 * cap for RS-08's source-map loading. JSON parsing, `sourcesContent`
 * handling, VLQ/mapping math and URL resolution all belong to RS-08 —
 * this module stops at bytes.
 */
import { DEFAULT_ARTIFACT_MAX_FILE_BYTES } from "./config.js";
import { ArtifactError, ArtifactTooLargeError } from "./errors.js";

export interface ReadArtifactOptions {
  /**
   * Hard cap in bytes (default `DEFAULT_ARTIFACT_MAX_FILE_BYTES`, the
   * 25 MiB RS-06 concept). Reads that would exceed it fail with
   * ArtifactTooLargeError instead of growing memory unboundedly.
   */
  maxBytes?: number;
}

/**
 * Load the artifact at `key` into a Buffer, capped at `maxBytes`.
 * Missing keys propagate ArtifactNotFoundError from the storage.
 */
export async function readArtifactToBuffer(
  storage: {
    get(key: string): Promise<AsyncIterable<Uint8Array>>;
  },
  key: string,
  options: ReadArtifactOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_ARTIFACT_MAX_FILE_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new ArtifactError(
      "ARTIFACT_INVALID_LIMIT",
      "maxBytes must be a positive integer",
    );
  }
  const stream = await storage.get(key);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        throw new ArtifactTooLargeError(key, total, maxBytes);
      }
      chunks.push(buffer);
    }
  } finally {
    await destroyQuietly(stream);
  }
  return Buffer.concat(chunks);
}

async function destroyQuietly(
  stream: AsyncIterable<Uint8Array>,
): Promise<void> {
  const destroyable = stream as Partial<{ destroy(): void }>;
  if (typeof destroyable.destroy === "function") {
    try {
      destroyable.destroy();
    } catch {
      // Best effort: the read outcome is what matters.
    }
  }
}
