/**
 * Filesystem `ArtifactStorage` rooted at `REPLAYBUG_ARTIFACT_DIR` (RS-05).
 *
 * Safety model:
 * - The root is validated once (`assertSafeArtifactRoot`): absolute,
 *   outside repo source trees, never a filesystem root or home dir.
 * - Every operation re-validates the key and containment-checks the
 *   resolved path, so even a caller bug cannot escape the root.
 * - Writes are atomic: stream to a uniquely-named temp file in the
 *   target directory, fsync, then rename. Temp files are removed on
 *   every failure path; concurrent puts to the same key use distinct
 *   temps (last rename wins — identical content by construction, since
 *   keys embed the content hash).
 *
 * No byte limits are enforced here: `REPLAYBUG_ARTIFACT_MAX_FILE_BYTES`
 * is parsed in `config.ts` for the shared env contract but enforced by
 * the RS-06 upload pipeline.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { assertSafeArtifactRoot, resolveArtifactDir } from "./config.js";
import { ArtifactNotFoundError, ArtifactStorageError } from "./errors.js";
import { resolveStoragePath, validateStorageKey } from "./storage-keys.js";
import type { ArtifactPutResult, ArtifactStorage } from "./types.js";

let tempCounter = 0;

function tempFileName(): string {
  tempCounter += 1;
  return `.tmp-${process.pid}-${tempCounter}-${randomBytes(8).toString("hex")}.part`;
}

function isMissing(error: unknown): boolean {
  return getErrnoCode(error) === "ENOENT";
}

function getErrnoCode(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return null;
}

/**
 * Atomic rename with bounded retries. On Windows a freshly-written temp
 * file can be briefly locked by scanners/indexers, and concurrent puts
 * to the same key race the same destination — both surface as transient
 * EPERM/EACCES/EBUSY. Retries preserve last-writer-wins semantics;
 * anything else (or exhaustion) fails safe with cleanup by the caller.
 */
async function renameWithRetry(
  tempPath: string,
  target: string,
): Promise<void> {
  const delaysMs = [5, 15, 40, 100, 250];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempPath, target);
      return;
    } catch (error) {
      const code = getErrnoCode(error);
      const transient =
        code === "EPERM" || code === "EACCES" || code === "EBUSY";
      const delay = delaysMs[attempt];
      if (!transient || delay === undefined) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export class LocalArtifactStorage implements ArtifactStorage {
  readonly root: string;

  constructor(options: { root: string }) {
    this.root = assertSafeArtifactRoot(options.root);
  }

  /**
   * Shared env-contract factory: API and worker both call this so they
   * point at the same directory. Docker volume wiring itself is RS-13.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): LocalArtifactStorage {
    return new LocalArtifactStorage({ root: resolveArtifactDir(env) });
  }

  async put(
    key: string,
    source: AsyncIterable<Uint8Array>,
  ): Promise<ArtifactPutResult> {
    validateStorageKey(key);
    const target = resolveStoragePath(this.root, key);
    await mkdir(path.dirname(target), { recursive: true });
    const tempPath = path.join(path.dirname(target), tempFileName());

    const handle = await open(tempPath, "wx").catch((error: unknown) => {
      throw new ArtifactStorageError("Could not create artifact temp file", {
        cause: error,
      });
    });
    const hasher = createHash("sha256");
    let sizeBytes = 0;
    try {
      for await (const chunk of source) {
        const buffer = toByteBuffer(chunk);
        hasher.update(buffer);
        sizeBytes += buffer.byteLength;
        let offset = 0;
        while (offset < buffer.byteLength) {
          const { bytesWritten } = await handle.write(
            buffer,
            offset,
            buffer.byteLength - offset,
          );
          if (bytesWritten <= 0) {
            throw new ArtifactStorageError(
              "Short write while storing artifact",
            );
          }
          offset += bytesWritten;
        }
      }
      await handle.sync();
    } catch (error) {
      await closeQuietly(handle.close());
      await rm(tempPath, { force: true }).catch(() => undefined);
      if (error instanceof ArtifactStorageError) {
        throw error;
      }
      throw new ArtifactStorageError("Failed to store artifact", {
        cause: error,
      });
    }
    await closeQuietly(handle.close());
    try {
      await renameWithRetry(tempPath, target);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new ArtifactStorageError("Failed to finalize artifact", {
        cause: error,
      });
    }
    return { contentHash: hasher.digest("hex"), sizeBytes };
  }

  async get(key: string): Promise<Readable> {
    validateStorageKey(key);
    const target = resolveStoragePath(this.root, key);
    try {
      await stat(target);
    } catch (error) {
      if (isMissing(error)) {
        throw new ArtifactNotFoundError(key);
      }
      throw new ArtifactStorageError("Failed to read artifact", {
        cause: error,
      });
    }
    return createReadStream(target);
  }

  async exists(key: string): Promise<boolean> {
    validateStorageKey(key);
    const target = resolveStoragePath(this.root, key);
    try {
      const info = await stat(target);
      return info.isFile();
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw new ArtifactStorageError("Failed to stat artifact", {
        cause: error,
      });
    }
  }

  async delete(key: string): Promise<boolean> {
    validateStorageKey(key);
    const target = resolveStoragePath(this.root, key);
    try {
      await unlink(target);
      return true;
    } catch (error) {
      if (isMissing(error)) {
        return false;
      }
      throw new ArtifactStorageError("Failed to delete artifact", {
        cause: error,
      });
    }
  }
}

function toByteBuffer(chunk: Uint8Array): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new ArtifactStorageError(
    "Artifact streams must yield bytes (Buffer or Uint8Array)",
  );
}

async function closeQuietly(close: Promise<void>): Promise<void> {
  try {
    await close;
  } catch {
    // Close-after-error best effort; the original failure is what matters.
  }
}
