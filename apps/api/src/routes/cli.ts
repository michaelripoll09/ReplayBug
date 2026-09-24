import type { FastifyRequest } from "fastify";
import type { Multipart, MultipartFile } from "@fastify/multipart";
import type { ArtifactStorage } from "@replaybug/artifacts";
import type { Database } from "@replaybug/db";
import type { AppInstance } from "../instance.js";
import { authRequired, artifactTooLarge, validationError } from "../errors.js";
import { authenticateCliToken } from "../auth/cli-auth.js";
import { getCliProjectInfo } from "../services/cli.js";
import {
  checkArtifactPreflight,
  drizzleArtifactRecordStore,
  finalizeArtifactUpload,
  findCliReleaseOrThrow,
  stageRawUpload,
  toArtifactDto,
  type StagedRawUpload,
} from "../services/artifacts.js";
import { createCliRelease, listCliReleases } from "../services/releases.js";
import { sendDomainError } from "./helpers.js";
import { RATE_LIMIT_POLICIES } from "../plugins/rate-limit.js";

export interface CliArtifactsDeps {
  storage: ArtifactStorage;
  maxFileBytes: number;
  preflightMaxEntries: number;
  aggregateMaxBytes: number;
  stagingDir?: string | undefined;
}

export interface CliRouteDeps {
  db: Database;
  artifacts: CliArtifactsDeps;
}

const cliProjectJson = {
  type: "object",
  required: [
    "projectId",
    "projectName",
    "projectSlug",
    "workspaceId",
    "workspaceName",
    "timezone",
  ],
  properties: {
    projectId: { type: "string", format: "uuid" },
    projectName: { type: "string" },
    projectSlug: { type: "string" },
    workspaceId: { type: "string", format: "uuid" },
    workspaceName: { type: "string" },
    timezone: { type: "string" },
  },
} as const;

const errorJson = {
  type: "object",
  required: ["code", "message", "requestId"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    requestId: { type: "string" },
  },
} as const;

const cliReleaseJson = {
  type: "object",
  required: ["id", "version", "commit", "repositoryUrl", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    version: { type: "string" },
    commit: { type: ["string", "null"] },
    repositoryUrl: { type: ["string", "null"] },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const createReleaseBodyJson = {
  type: "object",
  required: ["version"],
  properties: {
    version: { type: "string" },
    commitSha: { type: "string" },
    repositoryUrl: { type: "string" },
  },
} as const;

const createReleaseResponseJson = {
  type: "object",
  required: ["release", "created"],
  properties: {
    release: cliReleaseJson,
    created: { type: "boolean" },
  },
} as const;

const cliReleaseListItemJson = {
  type: "object",
  required: ["version", "commit", "artifactCount", "createdAt"],
  properties: {
    version: { type: "string" },
    commit: { type: ["string", "null"] },
    artifactCount: { type: "integer", minimum: 0 },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const listReleasesResponseJson = {
  type: "object",
  required: ["releases"],
  properties: {
    releases: { type: "array", items: cliReleaseListItemJson },
  },
} as const;

const versionParamsJson = {
  type: "object",
  required: ["version"],
  properties: {
    version: { type: "string", minLength: 1, maxLength: 128 },
  },
} as const;

const artifactDtoJson = {
  type: "object",
  required: [
    "id",
    "artifactPath",
    "artifactType",
    "contentHash",
    "sizeBytes",
    "createdAt",
  ],
  properties: {
    id: { type: "string", format: "uuid" },
    artifactPath: { type: "string" },
    artifactType: { type: "string", enum: ["source_map", "minified_asset"] },
    contentHash: { type: "string" },
    sizeBytes: { type: "integer", minimum: 0 },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

const uploadArtifactResponseJson = {
  type: "object",
  required: ["artifact", "created"],
  properties: {
    artifact: artifactDtoJson,
    created: { type: "boolean" },
  },
} as const;

const preflightEntryJson = {
  type: "object",
  required: ["artifactPath", "artifactType", "contentHash", "sizeBytes"],
  properties: {
    artifactPath: { type: "string" },
    artifactType: { type: "string" },
    contentHash: { type: "string" },
    sizeBytes: { type: "integer", minimum: 0 },
  },
} as const;

const preflightBodyJson = {
  type: "object",
  required: ["artifacts"],
  properties: {
    artifacts: { type: "array", items: preflightEntryJson },
  },
} as const;

const preflightResultJson = {
  type: "object",
  required: [
    "artifactPath",
    "artifactType",
    "contentHash",
    "sizeBytes",
    "verdict",
  ],
  properties: {
    artifactPath: { type: "string" },
    artifactType: { type: "string" },
    contentHash: { type: "string" },
    sizeBytes: { type: "integer", minimum: 0 },
    verdict: { type: "string", enum: ["upload", "exists", "conflict"] },
  },
} as const;

const preflightResponseJson = {
  type: "object",
  required: ["release", "results"],
  properties: {
    release: {
      type: "object",
      required: ["id", "version"],
      properties: {
        id: { type: "string", format: "uuid" },
        version: { type: "string" },
      },
    },
    results: { type: "array", items: preflightResultJson },
  },
} as const;

/**
 * RS-03 CLI boundary routes (`/api/v1/cli/...`).
 *
 * Bearer-only authentication with `rb_sk_…` secret project tokens:
 * `Authorization: Bearer <token>`. Credentials in query strings are never
 * read and session cookies are never consulted, keeping token routes clearly
 * separated from session-cookie dashboard mutations. Later RS tasks extend
 * this namespace (releases, uploads) without changing the auth boundary.
 * Tags: CLI.
 *
 * RS-04 adds project-scoped releases: idempotent create (201 created /
 * 200 already-exists, distinguished by the `created` flag) and a
 * deterministic list (created_at, then version) with artifact counts.
 * The stored `commit_sha` surfaces as `commit`; identity metadata never
 * mutates silently — conflicting re-creates are 409
 * `RELEASE_VERSION_CONFLICT`.
 *
 * RS-06 adds the artifact pipeline under a release version: preflight
 * `check` (per-artifact upload/exists/conflict verdicts over a bounded
 * manifest) and multipart upload (server-side SHA-256 + size, Source
 * Map v3 validation for `.map`, release+path immutability with
 * idempotent same-hash returns and 409 ARTIFACT_PATH_CONFLICT on
 * differing bytes). The release comes from the URL and the project
 * from the bearer token — never from the body; client hashes are
 * advisory in preflight and never trusted at upload.
 */
export async function registerCliRoutes(
  app: AppInstance,
  deps: CliRouteDeps,
): Promise<void> {
  app.get(
    "/api/v1/cli/project",
    {
      schema: {
        tags: ["CLI"],
        description:
          "Resolve the owning project for a CLI secret token. Bearer-only authentication; never send credentials in query strings.",
        security: [{ bearerAuth: [] }],
        response: {
          200: cliProjectJson,
          401: errorJson,
          404: errorJson,
        },
      },
    },
    async (request, reply) => {
      try {
        const principal = await authenticateCliToken(
          deps.db,
          request.headers.authorization,
        );
        if (principal === null) {
          throw authRequired("Authentication required");
        }
        const info = await getCliProjectInfo(deps.db, principal);
        await reply.send(info);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/cli/releases",
    {
      schema: {
        tags: ["CLI"],
        description:
          "Create a project-scoped release. Idempotent: identical re-creates return 200 with created=false; differing identity metadata returns 409 RELEASE_VERSION_CONFLICT. Bearer-only authentication.",
        security: [{ bearerAuth: [] }],
        body: createReleaseBodyJson,
        response: {
          200: createReleaseResponseJson,
          201: createReleaseResponseJson,
          400: errorJson,
          401: errorJson,
          409: errorJson,
        },
      },
    },
    async (request, reply) => {
      try {
        const principal = await authenticateCliToken(
          deps.db,
          request.headers.authorization,
        );
        if (principal === null) {
          throw authRequired("Authentication required");
        }
        const body = request.body as {
          version?: unknown;
          commitSha?: unknown;
          repositoryUrl?: unknown;
        };
        const result = await createCliRelease(deps.db, principal, body);
        await reply.status(result.created ? 201 : 200).send(result);
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.get(
    "/api/v1/cli/releases",
    {
      schema: {
        tags: ["CLI"],
        description:
          "List project-scoped releases in deterministic order (created_at, then version) with artifact counts. Bearer-only authentication; never exposes credentials.",
        security: [{ bearerAuth: [] }],
        response: {
          200: listReleasesResponseJson,
          401: errorJson,
        },
      },
    },
    async (request, reply) => {
      try {
        const principal = await authenticateCliToken(
          deps.db,
          request.headers.authorization,
        );
        if (principal === null) {
          throw authRequired("Authentication required");
        }
        const releases = await listCliReleases(deps.db, principal);
        await reply.send({ releases });
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/cli/releases/:version/artifacts/check",
    {
      schema: {
        tags: ["CLI"],
        description:
          "Preflight a bounded artifact manifest (max ~500 entries, ~250 MiB aggregate) for a release. Per-artifact verdict: upload (not stored), exists (same path+hash stored), conflict (same path, different hash). Advisory only — the server revalidates everything at upload and never trusts client hashes. Bearer-only authentication.",
        security: [{ bearerAuth: [] }],
        params: versionParamsJson,
        body: preflightBodyJson,
        response: {
          200: preflightResponseJson,
          400: errorJson,
          401: errorJson,
          404: errorJson,
          413: errorJson,
        },
      },
    },
    async (request, reply) => {
      try {
        const principal = await authenticateCliToken(
          deps.db,
          request.headers.authorization,
        );
        if (principal === null) {
          throw authRequired("Authentication required");
        }
        const params = request.params as { version?: unknown };
        const release = await findCliReleaseOrThrow(
          deps.db,
          principal,
          params.version,
        );
        const store = drizzleArtifactRecordStore(deps.db);
        const results = await checkArtifactPreflight(
          store,
          release.id,
          request.body,
          {
            maxFileBytes: deps.artifacts.maxFileBytes,
            maxEntries: deps.artifacts.preflightMaxEntries,
            aggregateMaxBytes: deps.artifacts.aggregateMaxBytes,
          },
        );
        await reply.send({
          release: { id: release.id, version: params.version },
          results,
        });
      } catch (error) {
        await sendDomainError(request, reply, error);
      }
    },
  );

  app.post(
    "/api/v1/cli/releases/:version/artifacts",
    {
      config: {
        // Artifact upload stages, hashes, and validates file bytes (30/min).
        rateLimit: { ...RATE_LIMIT_POLICIES.cliArtifactUpload },
      },
      schema: {
        tags: ["CLI"],
        description:
          "Upload one artifact to a release as multipart/form-data with exactly one file part plus text fields artifactPath (canonical POSIX relative path, e.g. assets/app.js.map) and artifactType (source_map for .map, minified_asset for .js/.mjs/.cjs). Server-side SHA-256 + size; `.map` must be Source Map v3; same path+hash is idempotent (200 created=false), same path with different bytes is 409 ARTIFACT_PATH_CONFLICT with no overwrite. Bearer-only authentication.",
        security: [{ bearerAuth: [] }],
        consumes: ["multipart/form-data"],
        params: versionParamsJson,
        response: {
          200: uploadArtifactResponseJson,
          201: uploadArtifactResponseJson,
          400: errorJson,
          401: errorJson,
          404: errorJson,
          409: errorJson,
          413: errorJson,
          503: errorJson,
        },
      },
    },
    async (request, reply) => {
      try {
        const principal = await authenticateCliToken(
          deps.db,
          request.headers.authorization,
        );
        if (principal === null) {
          throw authRequired("Authentication required");
        }
        const params = request.params as { version?: unknown };
        const release = await findCliReleaseOrThrow(
          deps.db,
          principal,
          params.version,
        );
        const controller = new AbortController();
        const onClose = (): void => {
          // RS-07 real-socket fix: `close` on the raw request also fires
          // on NORMAL completion (the message is fully received long
          // before staging finishes), so an unconditional abort kills
          // every real upload with "aborted by client disconnect" while
          // `inject` (which never emits `close`) stays green. Only a
          // premature close — the client going away mid-request, i.e.
          // the message never completed — aborts the staging.
          if (request.raw.complete !== true) {
            controller.abort();
          }
        };
        request.raw.on("close", onClose);
        try {
          const parsed = await readMultipartUpload(request, {
            maxFileBytes: deps.artifacts.maxFileBytes,
            stagingDir: deps.artifacts.stagingDir,
            signal: controller.signal,
          });
          const store = drizzleArtifactRecordStore(deps.db);
          const result = await finalizeArtifactUpload(
            store,
            deps.artifacts.storage,
            release,
            parsed.staged,
            {
              artifactPath: parsed.fields.get("artifactPath"),
              artifactType: parsed.fields.get("artifactType"),
              mimeType: parsed.mimeType,
            },
            { maxFileBytes: deps.artifacts.maxFileBytes },
          );
          await reply.status(result.created ? 201 : 200).send({
            artifact: toArtifactDto(result.record),
            created: result.created,
          });
        } finally {
          request.raw.off("close", onClose);
        }
      } catch (error) {
        await sendDomainError(request, reply, mapMultipartError(error));
      }
    },
  );
}

interface ParsedMultipartUpload {
  staged: StagedRawUpload;
  fields: Map<string, unknown>;
  mimeType: unknown;
}

interface ReadMultipartOptions {
  maxFileBytes: number;
  stagingDir?: string | undefined;
  signal: AbortSignal;
}

/**
 * Single-pass multipart read: text fields are collected (bounded by the
 * plugin's fieldSize limit) while the first file part is staged to temp
 * inline (bounded by the per-file cap, truncation-guarded) — wire order
 * independence without unbounded buffering. Extra files are drained and
 * rejected; a missing file is 400. Staging is removed when iteration
 * itself fails; `finalizeArtifactUpload` owns it afterwards.
 */
async function readMultipartUpload(
  request: FastifyRequest,
  options: ReadMultipartOptions,
): Promise<ParsedMultipartUpload> {
  if (typeof request.isMultipart !== "function" || !request.isMultipart()) {
    throw validationError("Artifact upload requires multipart/form-data");
  }
  const fields = new Map<string, unknown>();
  let staged: StagedRawUpload | undefined;
  let mimeType: unknown;
  let fileCount = 0;
  try {
    const parts: AsyncIterable<Multipart> = request.parts();
    for await (const part of parts) {
      if (part.type === "file") {
        fileCount += 1;
        if (fileCount > 1) {
          // Drain extras so busboy keeps flowing; rejected below.
          part.file.resume();
          continue;
        }
        mimeType = part.mimetype;
        staged = await stageRawUpload(
          truncateGuarded(part, options.maxFileBytes),
          {
            maxFileBytes: options.maxFileBytes,
            stagingDir: options.stagingDir,
          },
          options.signal,
        );
      } else if (!fields.has(part.fieldname)) {
        fields.set(part.fieldname, part.value);
      }
    }
  } catch (error) {
    if (staged !== undefined) {
      const { rm } = await import("node:fs/promises");
      await rm(staged.dir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw error;
  }
  if (fileCount > 1) {
    if (staged !== undefined) {
      const { rm } = await import("node:fs/promises");
      await rm(staged.dir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    throw validationError("Artifact upload accepts exactly one file");
  }
  if (staged === undefined) {
    throw validationError("Artifact upload requires a file part");
  }
  return { staged, fields, mimeType };
}

/**
 * Busboy ends capped streams early with `truncated=true` and NO error
 * to the consumer — without this guard a truncated upload would stage
 * as a short (valid-looking) file. Re-checking after exhaustion turns
 * the silent truncation into 413 ARTIFACT_TOO_LARGE before anything
 * persists.
 */
async function* truncateGuarded(
  part: MultipartFile,
  maxFileBytes: number,
): AsyncIterable<Uint8Array> {
  yield* part.file;
  const truncated = (part.file as { truncated?: unknown }).truncated;
  if (truncated === true) {
    throw artifactTooLarge(
      `Artifact exceeds the ${maxFileBytes}-byte per-file cap`,
    );
  }
}

/**
 * Map @fastify/multipart transport errors onto the CLI domain codes.
 * Domain errors pass through untouched.
 */
function mapMultipartError(error: unknown): unknown {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    const code = (error as { code: string }).code;
    switch (code) {
      case "FST_REQ_FILE_TOO_LARGE":
        // Busboy-level cap breach: normalize to the CLI vocabulary so
        // RS-07 can branch on one code (the plugin's own 413 carries
        // FST_REQ_FILE_TOO_LARGE instead).
        return artifactTooLarge();
      case "FST_FILES_LIMIT":
      case "FST_FIELDS_LIMIT":
      case "FST_PARTS_LIMIT":
        return validationError("Multipart upload exceeds field/file limits");
      case "FST_INVALID_MULTIPART_CONTENT_TYPE":
        return validationError("Artifact upload requires multipart/form-data");
      case "FST_MP_PREMATURE_CLOSE":
        return validationError("Artifact upload was interrupted");
      case "FST_PROTO_VIOLATION":
        return validationError("Artifact upload has an invalid field name");
      default:
        break;
    }
  }
  return error;
}
