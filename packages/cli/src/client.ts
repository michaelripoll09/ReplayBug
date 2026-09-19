/**
 * RS-07 network client on the Node built-in `fetch` (no axios).
 *
 * Base URL + `Authorization: Bearer` header, JSON plus multipart bodies,
 * per-request timeouts, and safe error normalization that always keeps
 * the server `requestId` when one is reported. The client never logs —
 * in particular it never logs the `Authorization` header or the token.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { CliError } from "./errors.js";

export interface CliProjectInfo {
  projectId: string;
  projectName: string;
  projectSlug: string;
  workspaceId: string;
  workspaceName: string;
  timezone: string;
}

export interface CliRelease {
  id: string;
  version: string;
  commit: string | null;
  repositoryUrl: string | null;
  createdAt: string;
}

export interface CreateReleaseResult {
  release: CliRelease;
  created: boolean;
}

export interface CliReleaseListItem {
  version: string;
  commit: string | null;
  artifactCount: number;
  createdAt: string;
}

export type UploadArtifactType = "source_map" | "minified_asset";

export interface PreflightEntry {
  artifactPath: string;
  artifactType: UploadArtifactType;
  contentHash: string;
  sizeBytes: number;
}

export type PreflightVerdict = "upload" | "exists" | "conflict";

export interface PreflightResult extends PreflightEntry {
  verdict: PreflightVerdict;
}

export interface CreateReleaseInput {
  version: string;
  commitSha?: string | undefined;
  repositoryUrl?: string | undefined;
}

export interface UploadFileInput {
  artifactPath: string;
  artifactType: UploadArtifactType;
  absolutePath: string;
}

export interface UploadArtifactResult {
  created: boolean;
}

export interface ApiClientOptions {
  apiUrl: string;
  token: string;
  /** Timeout for JSON requests (ms). */
  jsonTimeoutMs?: number | undefined;
  /** Timeout for multipart uploads (ms). */
  uploadTimeoutMs?: number | undefined;
}

export interface CliApiClient {
  getProject(): Promise<CliProjectInfo>;
  createRelease(input: CreateReleaseInput): Promise<CreateReleaseResult>;
  listReleases(): Promise<CliReleaseListItem[]>;
  checkPreflight(
    version: string,
    entries: PreflightEntry[],
  ): Promise<PreflightResult[]>;
  uploadArtifact(
    version: string,
    file: UploadFileInput,
  ): Promise<UploadArtifactResult>;
}

const JSON_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const REQUEST_ID_HEADER = "x-request-id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function hasNullableString(
  record: Record<string, unknown>,
  key: string,
): boolean {
  const value = record[key];
  return value === null || typeof value === "string";
}

function hintForServerCode(code: string): string | undefined {
  switch (code) {
    case "AUTH_REQUIRED":
      return "Verify REPLAYBUG_AUTH_TOKEN holds a current secret token (rb_sk_…) for this project. Public keys, revoked tokens, and mistyped values are rejected — create a fresh token in Project Settings → Secret tokens.";
    case "RELEASE_VERSION_CONFLICT":
      return "That version already exists with different commit/repository metadata. Re-run with matching --commit-sha/--repository-url, or pick a new version.";
    case "ARTIFACT_PATH_CONFLICT":
      return "The stored bytes for that path differ, so the CLI refuses to overwrite. Restore the matching file contents or upload under a new release version.";
    case "INVALID_SOURCE_MAP":
      return "The file is not a valid Source Map v3 document (JSON object with version 3, sources[], and a mappings string). Rebuild the map and retry.";
    case "ARTIFACT_TOO_LARGE":
      return "The file exceeds the server per-file cap. Ship smaller bundles/maps or raise the server limit before retrying.";
    case "ARTIFACT_STORAGE_UNAVAILABLE":
      return "Artifact storage is temporarily unavailable; telemetry and ingest keep working. Wait and retry the upload.";
    case "NOT_FOUND":
      return "The release does not exist under this project token. Create it first with `releases create`, then retry.";
    case "VALIDATION_ERROR":
    case "ARTIFACT_PATH_INVALID":
    case "INVALID_ARTIFACT_TYPE":
      return undefined;
    default:
      return undefined;
  }
}

/** Friendly mapping for transport-level failures (no requestId exists). */
function transportError(apiUrl: string, cause: unknown): CliError {
  const detail =
    cause instanceof Error && cause.message.length > 0
      ? ` (${cause.message})`
      : "";
  return new CliError(
    `Cannot reach the API at ${apiUrl}${detail}. Is the API running, and is --api-url (or REPLAYBUG_API_URL) correct?`,
    {
      hint: `Start the API locally or point --api-url at the right base URL (for example http://localhost:4001).`,
    },
  );
}

interface ErrorEnvelope {
  code: string;
  message: string;
  requestId?: string | undefined;
}

function readEnvelope(body: unknown): ErrorEnvelope | null {
  if (!isRecord(body)) {
    return null;
  }
  const code = asString(body["code"]);
  const message = asString(body["message"]);
  if (code === null || message === null) {
    return null;
  }
  const requestId = asString(body["requestId"]) ?? undefined;
  return { code, message, requestId };
}

export function createApiClient(options: ApiClientOptions): CliApiClient {
  const apiUrl = options.apiUrl;
  const token = options.token;
  const jsonTimeoutMs = options.jsonTimeoutMs ?? JSON_TIMEOUT_MS;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? UPLOAD_TIMEOUT_MS;

  function authHeaders(): Record<string, string> {
    // The only place the token is used: the Authorization header value.
    // It is never logged, never interpolated into messages, and never
    // sent anywhere except the configured API base URL.
    return { authorization: `Bearer ${token}` };
  }

  function requestIdFrom(
    envelope: ErrorEnvelope | null,
    response: Response,
  ): string | undefined {
    if (envelope?.requestId !== undefined) {
      return envelope.requestId;
    }
    const header = response.headers.get(REQUEST_ID_HEADER);
    return header === null || header === "" ? undefined : header;
  }

  async function throwForStatus(
    response: Response,
    action: string,
  ): Promise<never> {
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      body = null;
    }
    const envelope = readEnvelope(body);
    const requestId = requestIdFrom(envelope, response);
    if (envelope !== null) {
      throw new CliError(`${action} failed: ${envelope.message}`, {
        serverCode: envelope.code,
        status: response.status,
        requestId,
        hint: hintForServerCode(envelope.code),
      });
    }
    throw new CliError(
      `${action} failed: the API returned status ${response.status} with an unexpected body.`,
      { status: response.status, requestId },
    );
  }

  async function getJson(
    path: string,
    action: string,
  ): Promise<{ body: unknown; requestId: string | undefined }> {
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method: "GET",
        headers: { ...authHeaders(), accept: "application/json" },
        signal: AbortSignal.timeout(jsonTimeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new CliError(
          `${action} timed out after ${jsonTimeoutMs}ms against ${apiUrl}. Is the API reachable?`,
        );
      }
      throw transportError(apiUrl, error);
    }
    if (!response.ok) {
      await throwForStatus(response, action);
    }
    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new CliError(
        `${action} failed: the API returned status ${response.status} with a body that is not JSON.`,
        { status: response.status, requestId: requestId ?? undefined },
      );
    }
    return { body, requestId };
  }

  async function postJson(
    path: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<{ body: unknown; requestId: string | undefined }> {
    let response: Response;
    try {
      response = await fetch(`${apiUrl}${path}`, {
        method: "POST",
        headers: {
          ...authHeaders(),
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(jsonTimeoutMs),
      });
    } catch (error) {
      if (isTimeout(error)) {
        throw new CliError(
          `${action} timed out after ${jsonTimeoutMs}ms against ${apiUrl}. Is the API reachable?`,
        );
      }
      throw transportError(apiUrl, error);
    }
    if (!response.ok) {
      await throwForStatus(response, action);
    }
    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new CliError(
        `${action} failed: the API returned status ${response.status} with a body that is not JSON.`,
        { status: response.status, requestId: requestId ?? undefined },
      );
    }
    return { body, requestId };
  }

  return {
    async getProject(): Promise<CliProjectInfo> {
      const { body } = await getJson("/api/v1/cli/project", "projects info");
      if (!isRecord(body)) {
        throw new CliError(
          "projects info failed: the API returned an unexpected response shape.",
        );
      }
      const fields = [
        "projectId",
        "projectName",
        "projectSlug",
        "workspaceId",
        "workspaceName",
        "timezone",
      ] as const;
      for (const field of fields) {
        if (typeof body[field] !== "string") {
          throw new CliError(
            "projects info failed: the API returned an unexpected response shape.",
          );
        }
      }
      return {
        projectId: body["projectId"] as string,
        projectName: body["projectName"] as string,
        projectSlug: body["projectSlug"] as string,
        workspaceId: body["workspaceId"] as string,
        workspaceName: body["workspaceName"] as string,
        timezone: body["timezone"] as string,
      };
    },

    async createRelease(
      input: CreateReleaseInput,
    ): Promise<CreateReleaseResult> {
      const payload: Record<string, unknown> = { version: input.version };
      if (input.commitSha !== undefined) {
        payload["commitSha"] = input.commitSha;
      }
      if (input.repositoryUrl !== undefined) {
        payload["repositoryUrl"] = input.repositoryUrl;
      }
      const { body } = await postJson(
        "/api/v1/cli/releases",
        "releases create",
        payload,
      );
      if (!isRecord(body) || !isRecord(body["release"])) {
        throw new CliError(
          "releases create failed: the API returned an unexpected response shape.",
        );
      }
      const release = body["release"];
      if (
        typeof release["id"] !== "string" ||
        typeof release["version"] !== "string" ||
        !hasNullableString(release, "commit") ||
        !hasNullableString(release, "repositoryUrl") ||
        typeof release["createdAt"] !== "string"
      ) {
        throw new CliError(
          "releases create failed: the API returned an unexpected response shape.",
        );
      }
      if (typeof body["created"] !== "boolean") {
        throw new CliError(
          "releases create failed: the API returned an unexpected response shape.",
        );
      }
      return {
        release: {
          id: release["id"],
          version: release["version"],
          commit: release["commit"] as string | null,
          repositoryUrl: release["repositoryUrl"] as string | null,
          createdAt: release["createdAt"] as string,
        },
        created: body["created"],
      };
    },

    async listReleases(): Promise<CliReleaseListItem[]> {
      const { body } = await getJson("/api/v1/cli/releases", "releases list");
      if (!isRecord(body) || !Array.isArray(body["releases"])) {
        throw new CliError(
          "releases list failed: the API returned an unexpected response shape.",
        );
      }
      const items: CliReleaseListItem[] = [];
      for (const entry of body["releases"]) {
        if (!isRecord(entry)) {
          throw new CliError(
            "releases list failed: the API returned an unexpected response shape.",
          );
        }
        if (
          typeof entry["version"] !== "string" ||
          !hasNullableString(entry, "commit") ||
          typeof entry["artifactCount"] !== "number" ||
          typeof entry["createdAt"] !== "string"
        ) {
          throw new CliError(
            "releases list failed: the API returned an unexpected response shape.",
          );
        }
        items.push({
          version: entry["version"],
          commit: entry["commit"] as string | null,
          artifactCount: entry["artifactCount"],
          createdAt: entry["createdAt"] as string,
        });
      }
      return items;
    },

    async checkPreflight(
      version: string,
      entries: PreflightEntry[],
    ): Promise<PreflightResult[]> {
      const { body } = await postJson(
        `/api/v1/cli/releases/${encodeURIComponent(version)}/artifacts/check`,
        "sourcemaps preflight",
        { artifacts: entries },
      );
      if (!isRecord(body) || !Array.isArray(body["results"])) {
        throw new CliError(
          "sourcemaps preflight failed: the API returned an unexpected response shape.",
        );
      }
      const results: PreflightResult[] = [];
      for (const entry of body["results"]) {
        if (!isRecord(entry)) {
          throw new CliError(
            "sourcemaps preflight failed: the API returned an unexpected response shape.",
          );
        }
        const artifactType = entry["artifactType"];
        const verdict = entry["verdict"];
        if (
          typeof entry["artifactPath"] !== "string" ||
          (artifactType !== "source_map" &&
            artifactType !== "minified_asset") ||
          typeof entry["contentHash"] !== "string" ||
          typeof entry["sizeBytes"] !== "number" ||
          (verdict !== "upload" &&
            verdict !== "exists" &&
            verdict !== "conflict")
        ) {
          throw new CliError(
            "sourcemaps preflight failed: the API returned an unexpected response shape.",
          );
        }
        results.push({
          artifactPath: entry["artifactPath"],
          artifactType,
          contentHash: entry["contentHash"],
          sizeBytes: entry["sizeBytes"],
          verdict,
        });
      }
      return results;
    },

    async uploadArtifact(
      version: string,
      file: UploadFileInput,
    ): Promise<UploadArtifactResult> {
      let bytes: Buffer;
      try {
        bytes = await readFile(file.absolutePath);
      } catch {
        throw new CliError(
          `Cannot read "${file.artifactPath}" for upload. Did the file change during the run?`,
        );
      }
      const form = new FormData();
      form.append("artifactPath", file.artifactPath);
      form.append("artifactType", file.artifactType);
      form.append("file", new Blob([bytes]), basename(file.artifactPath));
      let response: Response;
      const uploadPath = `${apiUrl}/api/v1/cli/releases/${encodeURIComponent(version)}/artifacts`;
      try {
        response = await fetch(uploadPath, {
          method: "POST",
          headers: { ...authHeaders(), accept: "application/json" },
          body: form,
          signal: AbortSignal.timeout(uploadTimeoutMs),
        });
      } catch (error) {
        if (isTimeout(error)) {
          throw new CliError(
            `Upload of "${file.artifactPath}" timed out after ${uploadTimeoutMs}ms against ${apiUrl}. Is the API reachable?`,
          );
        }
        throw transportError(apiUrl, error);
      }
      if (!response.ok) {
        let uploadErrorBody: unknown;
        try {
          uploadErrorBody = (await response.json()) as unknown;
        } catch {
          uploadErrorBody = null;
        }
        const envelope = readEnvelope(uploadErrorBody);
        const requestId = requestIdFrom(envelope, response);
        if (envelope !== null) {
          const message =
            envelope.code === "ARTIFACT_PATH_CONFLICT" ||
            envelope.code === "INVALID_SOURCE_MAP" ||
            envelope.code === "ARTIFACT_TOO_LARGE"
              ? `Upload of "${file.artifactPath}" failed: ${envelope.message}`
              : `sourcemaps upload failed: ${envelope.message}`;
          throw new CliError(message, {
            serverCode: envelope.code,
            status: response.status,
            requestId,
            hint: hintForServerCode(envelope.code),
          });
        }
        throw new CliError(
          `Upload of "${file.artifactPath}" failed: the API returned status ${response.status} with an unexpected body.`,
          { status: response.status, requestId },
        );
      }
      let body: unknown;
      try {
        body = (await response.json()) as unknown;
      } catch {
        throw new CliError(
          `Upload of "${file.artifactPath}" failed: the API returned a body that is not JSON.`,
          { status: response.status },
        );
      }
      if (!isRecord(body) || typeof body["created"] !== "boolean") {
        throw new CliError(
          `Upload of "${file.artifactPath}" failed: the API returned an unexpected response shape.`,
        );
      }
      return { created: body["created"] };
    },
  };
}

function isTimeout(error: unknown): boolean {
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError.
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: unknown }).name === "TimeoutError"
  );
}
