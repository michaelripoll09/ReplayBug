/**
 * RS-08 stack symbolication (worker-side).
 *
 * Uses the maintained `@jridgewell/trace-mapping` library (no custom VLQ,
 * no network). Artifact bytes are loaded through `@replaybug/artifacts`
 * (`readArtifactToBuffer`); release/artifact metadata comes from
 * `@replaybug/db` with an exact `(project_id, version)` lookup (telemetry
 * may predate registration; no FK from events; no cross-project matching).
 *
 * Lookup order per generated artifact path within one release:
 *  1. the uploaded minified asset's trailing `sourceMappingURL`, ONLY when
 *     it is a relative local same-release reference (remote
 *     `http/https/file/ftp/data:` or any non-relative form is NEVER fetched);
 *  2. the exact sibling `<generated-path>.map`;
 *  3. another same-release map ONLY when its metadata proves correspondence
 *     (the map's `file` hint resolves to the generated path) — never
 *     fuzzy-matched.
 *
 * Column semantics (see `columns.ts`): browser frames carry display
 * coordinates (1-based line, 1-based column); Source Map v3 generated
 * positions are 1-based line, 0-based column. The display→generated
 * conversion (`displayColumnToGenerated`) runs once per lookup; mapped
 * originals convert back (`generatedColumnToDisplay`) so raw and mapped
 * frames share one display coordinate space.
 *
 * Degradation: missing/invalid/unavailable maps yield raw frames with a
 * cause status (`map_not_found` / `invalid_map` / `storage_unavailable`),
 * never a crash and never fabricated sources. Storage keys are never
 * included in the result.
 */

import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import {
  ArtifactNotFoundError,
  ArtifactStorageError,
  InvalidSourceMapError,
  readArtifactToBuffer,
  validateSourceMapBytes,
  type ArtifactStorage,
} from "@replaybug/artifacts";
import {
  ReleaseRepo,
  type DbOrTx,
  type ReleaseArtifactRow,
  type ReleaseRow,
} from "@replaybug/db";
import {
  displayColumnToGenerated,
  generatedColumnToDisplay,
} from "./columns.js";
import { normalizeGeneratedUrl } from "./normalize.js";
import {
  isRemoteSourceMappingUrl,
  parseTrailingSourceMappingURL,
  resolveRelativeMapReference,
} from "./source-mapping-url.js";
import type {
  MappedSymbolicationFrame,
  RawSymbolicationFrame,
  SymbolicationResult,
  SymbolicationStatus,
} from "./types.js";

export interface SymbolicateDeps {
  db: DbOrTx;
  storage: Pick<ArtifactStorage, "get">;
}

export interface SymbolicateInput {
  projectId: string;
  release: string | null;
  payload: unknown;
}

interface LoadedMap {
  artifactPath: string;
  traceMap: TraceMap | null;
  invalid: boolean;
}

type PathOutcome =
  | { kind: "mapped"; map: LoadedMap }
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "unavailable" };

/**
 * Symbolicate an event payload against uploaded release artifacts.
 * Never throws for missing/invalid/unavailable maps (they become statuses);
 * transient DB failures propagate so pg-boss can retry them.
 */
export async function symbolicateEvent(
  deps: SymbolicateDeps,
  input: SymbolicateInput,
): Promise<SymbolicationResult> {
  const rawFrames = extractRawFrames(input.payload);

  if (typeof input.release !== "string" || input.release.trim() === "") {
    return unmappedResult("no_release", rawFrames);
  }
  const release = await ReleaseRepo.findReleaseByProjectAndVersion(
    deps.db,
    input.projectId,
    input.release,
  );
  if (release === undefined) {
    return unmappedResult("release_not_found", rawFrames);
  }
  if (rawFrames.length === 0) {
    // Nothing to map: vacuous success once the release is proven to exist.
    return {
      status: "mapped",
      rawFrames,
      mappedFrames: [],
      mappedFrameCount: 0,
    };
  }

  const mapCache = new Map<string, LoadedMap>();
  let sawUnavailable = false;
  let sawInvalid = false;

  const mappedFrames: MappedSymbolicationFrame[] = [];
  for (const raw of rawFrames) {
    const generatedPath =
      raw.filename === "" ? null : normalizeGeneratedUrl(raw.filename);
    if (generatedPath === null) {
      mappedFrames.push(unmappedFrame(raw));
      continue;
    }
    const outcome = await resolveMapForGeneratedPath(
      deps,
      release,
      generatedPath,
      mapCache,
    );
    if (outcome.kind === "unavailable") {
      sawUnavailable = true;
      mappedFrames.push(unmappedFrame(raw));
      continue;
    }
    if (outcome.kind === "invalid") {
      sawInvalid = true;
      mappedFrames.push(unmappedFrame(raw));
      continue;
    }
    if (outcome.kind === "missing") {
      mappedFrames.push(unmappedFrame(raw));
      continue;
    }
    const mapped = applyMap(outcome.map, raw);
    if (mapped === null) {
      // No mapping for this exact position: unmappable, left as-is.
      mappedFrames.push(unmappedFrame(raw));
      continue;
    }
    mappedFrames.push(mapped);
  }

  const mappedFrameCount = mappedFrames.filter((f) => f.mapped).length;
  let status: SymbolicationStatus;
  if (mappedFrameCount === mappedFrames.length && mappedFrames.length > 0) {
    status = "mapped";
  } else if (mappedFrameCount > 0) {
    status = "partially_mapped";
  } else if (sawUnavailable) {
    status = "storage_unavailable";
  } else if (sawInvalid) {
    status = "invalid_map";
  } else {
    status = "map_not_found";
  }
  return { status, rawFrames, mappedFrames, mappedFrameCount };
}

function unmappedResult(
  status: SymbolicationStatus,
  rawFrames: RawSymbolicationFrame[],
): SymbolicationResult {
  return {
    status,
    rawFrames,
    mappedFrames: rawFrames.map(unmappedFrame),
    mappedFrameCount: 0,
  };
}

function unmappedFrame(raw: RawSymbolicationFrame): MappedSymbolicationFrame {
  return {
    filename: raw.filename,
    source: raw.filename,
    function: raw.function,
    name: null,
    line: raw.lineno,
    column: raw.colno,
    inApplication: raw.inApp,
    mapped: false,
  };
}

/**
 * Extract raw frames from any stored payload shape. Only the telemetry
 * coordinates are read (`filename`, `function`, `lineno`, `colno`,
 * `in_app`); client-submitted `mapped`/`source`/`symbolication` fields are
 * ignored — enrichment is worker-computed only.
 */
function extractRawFrames(payload: unknown): RawSymbolicationFrame[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const values = (payload as Record<string, unknown>)["values"];
  if (!Array.isArray(values)) {
    return [];
  }
  const frames: RawSymbolicationFrame[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null) {
      continue;
    }
    const stacktrace = (value as Record<string, unknown>)["stacktrace"];
    if (typeof stacktrace !== "object" || stacktrace === null) {
      continue;
    }
    const list = (stacktrace as Record<string, unknown>)["frames"];
    if (!Array.isArray(list)) {
      continue;
    }
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const filename =
        typeof record["filename"] === "string" ? record["filename"] : "";
      const fn =
        typeof record["function"] === "string" ? record["function"] : "";
      const lineno = toNonNegativeInt(record["lineno"]);
      const colno = toNonNegativeInt(record["colno"]);
      frames.push({
        filename,
        function: fn,
        lineno,
        colno,
        inApp: record["in_app"] === true,
      });
    }
  }
  return frames;
}

function toNonNegativeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.floor(value));
}

/**
 * Resolve the map for one generated artifact path following lookup order
 * (1) asset trailing sourceMappingURL → (2) exact sibling → (3) proven
 * correspondence. `mapCache` avoids re-loading one map for many frames.
 */
async function resolveMapForGeneratedPath(
  deps: SymbolicateDeps,
  release: ReleaseRow,
  generatedPath: string,
  mapCache: Map<string, LoadedMap>,
): Promise<PathOutcome> {
  // (1) Minified asset trailing sourceMappingURL, relative-local only.
  const asset = await findArtifactQuietly(deps.db, release.id, generatedPath);
  if (asset !== undefined && asset.artifactType === "minified_asset") {
    const fromComment = await mapFromAssetComment(
      deps,
      release,
      asset,
      generatedPath,
      mapCache,
    );
    if (fromComment !== null) {
      return fromComment;
    }
  }

  // (2) Exact sibling `<generated-path>.map`.
  const siblingPath = `${generatedPath}.map`;
  const sibling = await findArtifactQuietly(deps.db, release.id, siblingPath);
  if (sibling !== undefined && sibling.artifactType === "source_map") {
    const loaded = await loadMap(deps, sibling, mapCache);
    if (loaded === "unavailable") {
      return { kind: "unavailable" };
    }
    if (loaded.invalid) {
      return { kind: "invalid" };
    }
    return { kind: "mapped", map: loaded };
  }

  // (3) Proven correspondence only: another same-release map whose `file`
  // hint resolves back to the generated path. Never fuzzy-matched.
  const candidates = await listMapsQuietly(deps.db, release.id);
  let sawInvalid = false;
  let sawUnavailable = false;
  for (const candidate of candidates) {
    if (candidate.artifactPath === siblingPath) {
      continue;
    }
    const loaded = await loadMap(deps, candidate, mapCache);
    if (loaded === "unavailable") {
      sawUnavailable = true;
      continue;
    }
    if (loaded.invalid) {
      sawInvalid = true;
      continue;
    }
    if (provesCorrespondence(candidate.artifactPath, loaded, generatedPath)) {
      return { kind: "mapped", map: loaded };
    }
  }
  if (sawUnavailable) {
    return { kind: "unavailable" };
  }
  if (sawInvalid) {
    return { kind: "invalid" };
  }
  return { kind: "missing" };
}

async function findArtifactQuietly(
  db: DbOrTx,
  releaseId: string,
  artifactPath: string,
): Promise<ReleaseArtifactRow | undefined> {
  // DB failures propagate (transient → pg-boss retry); only storage and
  // map-content failures degrade. Metadata reads are cheap indexed selects.
  return ReleaseRepo.findArtifactByReleaseAndPath(db, releaseId, artifactPath);
}

async function listMapsQuietly(
  db: DbOrTx,
  releaseId: string,
): Promise<ReleaseArtifactRow[]> {
  const all = await ReleaseRepo.listArtifactsByRelease(db, releaseId);
  return all.filter((row) => row.artifactType === "source_map");
}

/**
 * Follow step (1): parse the asset's trailing comment and load the
 * referenced map when it is a relative local same-release reference.
 * Returns null to fall through to the sibling/proof steps; remote values
 * are ignored without any fetch.
 */
async function mapFromAssetComment(
  deps: SymbolicateDeps,
  release: ReleaseRow,
  asset: ReleaseArtifactRow,
  generatedPath: string,
  mapCache: Map<string, LoadedMap>,
): Promise<PathOutcome | null> {
  let text: string;
  try {
    const bytes = await readArtifactToBuffer(deps.storage, asset.storageKey);
    text = bytes.toString("utf8");
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      return null;
    }
    if (error instanceof ArtifactStorageError) {
      return { kind: "unavailable" };
    }
    return { kind: "unavailable" };
  }
  const reference = parseTrailingSourceMappingURL(text);
  if (reference === null || isRemoteSourceMappingUrl(reference)) {
    return null;
  }
  const resolved = resolveRelativeMapReference(generatedPath, reference);
  if (resolved === null) {
    return null;
  }
  const target = await findArtifactQuietly(deps.db, release.id, resolved);
  if (target === undefined || target.artifactType !== "source_map") {
    return null;
  }
  const loaded = await loadMap(deps, target, mapCache);
  if (loaded === "unavailable") {
    return { kind: "unavailable" };
  }
  if (loaded.invalid) {
    return { kind: "invalid" };
  }
  return { kind: "mapped", map: loaded };
}

/**
 * Load and validate one map artifact (cached). `"unavailable"` when the
 * blob cannot be read; `invalid: true` when bytes fail v3 validation or
 * trace-mapping construction. Never throws for content problems.
 */
async function loadMap(
  deps: SymbolicateDeps,
  artifact: ReleaseArtifactRow,
  mapCache: Map<string, LoadedMap>,
): Promise<LoadedMap | "unavailable"> {
  const cached = mapCache.get(artifact.artifactPath);
  if (cached !== undefined) {
    return cached;
  }
  let bytes: Buffer;
  try {
    bytes = await readArtifactToBuffer(deps.storage, artifact.storageKey);
  } catch (error) {
    if (error instanceof ArtifactNotFoundError) {
      // Registered row with no blob: storage lost it. Degrade as
      // unavailable (never fuzzy-match past the gap).
      return "unavailable";
    }
    return "unavailable";
  }
  let text: string;
  let parsed: unknown;
  try {
    text = bytes.toString("utf8");
    parsed = JSON.parse(text) as unknown;
  } catch {
    const invalid: LoadedMap = {
      artifactPath: artifact.artifactPath,
      traceMap: null,
      invalid: true,
    };
    mapCache.set(artifact.artifactPath, invalid);
    return invalid;
  }
  try {
    validateSourceMapBytes(bytes);
  } catch (error) {
    if (error instanceof InvalidSourceMapError) {
      const invalid: LoadedMap = {
        artifactPath: artifact.artifactPath,
        traceMap: null,
        invalid: true,
      };
      mapCache.set(artifact.artifactPath, invalid);
      return invalid;
    }
    throw error;
  }
  try {
    // Pass the artifact path as mapUrl so relative `sources` resolve
    // against the map's location (e.g. `../src/app.ts` in
    // `assets/app.js.map` becomes `src/app.ts`).
    const traceMap = new TraceMap(parsed as never, artifact.artifactPath);
    const loaded: LoadedMap = {
      artifactPath: artifact.artifactPath,
      traceMap,
      invalid: false,
    };
    mapCache.set(artifact.artifactPath, loaded);
    return loaded;
  } catch {
    const invalid: LoadedMap = {
      artifactPath: artifact.artifactPath,
      traceMap: null,
      invalid: true,
    };
    mapCache.set(artifact.artifactPath, invalid);
    return invalid;
  }
}

/**
 * Step (3) proof: the candidate map's `file` hint must resolve (relative
 * to the map's own directory) exactly to the generated path. Maps without
 * a usable `file` hint prove nothing and are skipped.
 */
function provesCorrespondence(
  mapArtifactPath: string,
  loaded: LoadedMap,
  generatedPath: string,
): boolean {
  if (loaded.traceMap === null) {
    return false;
  }
  const file = loaded.traceMap.file;
  if (typeof file !== "string" || file.trim() === "") {
    return false;
  }
  const resolved = resolveRelativeMapReference(mapArtifactPath, file);
  return resolved === generatedPath;
}

/** Map one raw frame through a loaded map; null when unmappable. */
function applyMap(
  loaded: LoadedMap,
  raw: RawSymbolicationFrame,
): MappedSymbolicationFrame | null {
  if (loaded.traceMap === null) {
    return null;
  }
  if (!Number.isInteger(raw.lineno) || raw.lineno < 1) {
    return null;
  }
  const needle = {
    line: raw.lineno,
    column: displayColumnToGenerated(raw.colno),
  };
  let position: {
    source: string | null;
    line: number | null;
    column: number | null;
    name: string | null;
  };
  try {
    position = originalPositionFor(loaded.traceMap, needle);
  } catch {
    return null;
  }
  if (
    position.source === null ||
    position.line === null ||
    position.column === null
  ) {
    return null;
  }
  const name = position.name;
  return {
    filename: position.source,
    source: position.source,
    function: name ?? raw.function,
    name,
    line: position.line,
    column: generatedColumnToDisplay(position.column),
    inApplication: raw.inApp,
    mapped: true,
  };
}
