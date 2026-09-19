/**
 * Explicit storage contract (RS-05).
 *
 * Streaming-first: `put` consumes a byte stream once while computing the
 * SHA-256/size inline (no whole-body buffering); `get` returns a readable
 * stream. Callers pass SERVER-GENERATED storage keys only (see
 * `buildArtifactStorageKey`) — never user-provided filesystem paths; there
 * is no API that accepts an arbitrary disk path.
 */
import type { Readable } from "node:stream";

export interface ArtifactPutResult {
  sizeBytes: number;
  contentHash: string;
}

export interface ArtifactStorage {
  /** Resolved absolute root all keys live under (operator config). */
  readonly root: string;

  /**
   * Atomically store `source` at `key` (temp file + rename). Resolves
   * with the streamed SHA-256 and size. Rejects with ArtifactKeyError
   * for malformed keys, ArtifactStorageError when the stream or disk
   * fails (temp files are always cleaned up).
   */
  put(
    key: string,
    source: AsyncIterable<Uint8Array>,
  ): Promise<ArtifactPutResult>;

  /**
   * Open a readable byte stream for `key`. Rejects with
   * ArtifactNotFoundError when absent, ArtifactKeyError when malformed.
   */
  get(key: string): Promise<Readable>;

  /** True when a blob exists at `key` (false when absent). */
  exists(key: string): Promise<boolean>;

  /** Remove the blob at `key`; true when deleted, false when absent. */
  delete(key: string): Promise<boolean>;
}
