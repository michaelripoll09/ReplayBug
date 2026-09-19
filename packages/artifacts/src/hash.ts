/**
 * Streaming SHA-256 / size helpers (RS-05).
 *
 * `LocalArtifactStorage.put` computes both inline in a single write pass;
 * these standalone helpers exist for callers that need the same digest
 * without storing (RS-06 server-side hash verification) or for
 * re-verifying bytes already on disk.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export interface ContentDigest {
  /** Lowercase hex SHA-256 over the exact byte stream. */
  contentHash: string;
  /** Total bytes consumed. */
  sizeBytes: number;
}

/** SHA-256 hex digest of an in-memory string or byte array. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 hex digest of in-memory bytes (artifact content addressing). */
export function computeContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Drain a byte stream once, returning its SHA-256 and size. Accepts any
 * async-iterable of bytes (Node `Readable`, `Readable.from`, generators).
 */
export async function hashStream(
  source: AsyncIterable<Uint8Array>,
): Promise<ContentDigest> {
  const hasher = createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of source) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hasher.update(buffer);
    sizeBytes += buffer.byteLength;
  }
  return { contentHash: hasher.digest("hex"), sizeBytes };
}

/** Hash the file at `filePath` via a read stream (never loads it whole). */
export function hashFile(filePath: string): Promise<ContentDigest> {
  return hashStream(createReadStream(filePath) as AsyncIterable<Uint8Array>);
}
