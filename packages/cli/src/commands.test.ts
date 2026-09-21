import { describe, expect, it } from "vitest";
import {
  planUploads,
  runSourcemapsUpload,
  type UploadSourcemapsArgs,
} from "./commands.js";
import { CliError } from "./errors.js";
import type { CliApiClient, PreflightResult } from "./client.js";
import type { ScannedArtifact, ScanResult } from "./scanner.js";

function artifact(artifactPath: string): ScannedArtifact {
  return {
    artifactPath,
    artifactType: artifactPath.endsWith(".map")
      ? "source_map"
      : "minified_asset",
    absolutePath: `/tmp/${artifactPath}`,
    sizeBytes: 10,
    contentHash: "b".repeat(64),
  };
}

function toResult(
  scanned: ScannedArtifact,
  verdict: PreflightResult["verdict"],
): PreflightResult {
  return {
    artifactPath: scanned.artifactPath,
    artifactType: scanned.artifactType,
    contentHash: scanned.contentHash,
    sizeBytes: scanned.sizeBytes,
    verdict,
  };
}

interface FakeClientState {
  calls: string[];
  createBehavior: "created" | "exists" | "conflict";
  verdicts: Record<string, PreflightResult["verdict"]>;
  failUploadPath: string | null;
}

function fakeClient(state: FakeClientState): CliApiClient {
  return {
    async getProject() {
      throw new CliError("not used");
    },
    async createRelease(input) {
      state.calls.push(`create:${input.version}`);
      if (state.createBehavior === "conflict") {
        throw new CliError("Release version already exists", {
          serverCode: "RELEASE_VERSION_CONFLICT",
          status: 409,
        });
      }
      return {
        release: {
          id: "r1",
          version: input.version,
          commit: null,
          repositoryUrl: null,
          createdAt: "2026-09-18T00:00:00.000Z",
        },
        created: state.createBehavior === "created",
      };
    },
    async listReleases() {
      state.calls.push("list");
      return [
        {
          version: "web@1.0.0",
          commit: null,
          artifactCount: 0,
          createdAt: "2026-09-18T00:00:00.000Z",
        },
      ];
    },
    async checkPreflight(_version, entries) {
      state.calls.push(`preflight:${entries.length}`);
      return entries.map((entry) => ({
        ...entry,
        verdict: state.verdicts[entry.artifactPath] ?? "upload",
      }));
    },
    async uploadArtifact(_version, file) {
      state.calls.push(`upload:${file.artifactPath}`);
      if (state.failUploadPath === file.artifactPath) {
        throw new CliError(`Upload of "${file.artifactPath}" failed: boom`, {
          serverCode: "INVALID_SOURCE_MAP",
          status: 400,
        });
      }
      return { created: true };
    },
  };
}

function writers() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    handlers: {
      stdout: (line: string): void => {
        out.push(line);
      },
      stderr: (line: string): void => {
        err.push(line);
      },
    },
  };
}

function scannedFixture(): ScannedArtifact[] {
  return [artifact("assets/a.js"), artifact("assets/a.js.map")];
}

function scanResult(artifacts: ScannedArtifact[]): ScanResult {
  return { root: "/tmp", artifacts, warnings: [] };
}

describe("preflight planner", () => {
  it("splits verdicts and treats unknown files as uploads", () => {
    const scanned = [
      artifact("assets/a.js.map"),
      artifact("assets/a.js"),
      artifact("assets/b.js.map"),
    ];
    const plan = planUploads(scanned, [
      toResult(scanned[0] as ScannedArtifact, "exists"),
      toResult(scanned[1] as ScannedArtifact, "conflict"),
    ]);
    expect(plan.alreadyPresent.map((a) => a.artifactPath)).toEqual([
      "assets/a.js.map",
    ]);
    expect(plan.conflicts.map((a) => a.artifactPath)).toEqual(["assets/a.js"]);
    expect(plan.toUpload.map((a) => a.artifactPath)).toEqual([
      "assets/b.js.map",
    ]);
  });
});

describe("sourcemaps upload flow", () => {
  function runArgs(
    state: FakeClientState,
    captured: ReturnType<typeof writers>,
    scanned: ScannedArtifact[],
  ): UploadSourcemapsArgs {
    return {
      client: fakeClient(state),
      scan: async () => scanResult(scanned),
      directory: "./dist",
      version: "web@1.0.0",
      json: false,
      writers: captured.handlers,
    };
  }

  it("uploads only upload verdicts and prints the summary", async () => {
    const state: FakeClientState = {
      calls: [],
      createBehavior: "created",
      verdicts: { "assets/a.js": "exists" },
      failUploadPath: null,
    };
    const captured = writers();
    await runSourcemapsUpload(runArgs(state, captured, scannedFixture()));
    expect(state.calls).toContain("upload:assets/a.js.map");
    expect(state.calls).not.toContain("upload:assets/a.js");
    expect(captured.out.join("\n")).toContain(
      "Found: 1 source map / 1 minified asset",
    );
    expect(captured.out.join("\n")).toContain("Uploaded: 1");
    expect(captured.out.join("\n")).toContain("Already present: 1");
  });

  it("confirms an existing release after a version conflict without uploading", async () => {
    const state: FakeClientState = {
      calls: [],
      createBehavior: "conflict",
      verdicts: {},
      failUploadPath: null,
    };
    const scanned = scannedFixture();
    const captured = writers();
    let error: unknown;
    try {
      await runSourcemapsUpload({
        client: fakeClient(state),
        scan: async () => scanResult(scanned),
        directory: "./dist",
        version: "web@9.9.9",
        json: false,
        writers: captured.handlers,
      });
    } catch (caught) {
      error = caught;
    }
    // web@9.9.9 is not in the fake list, so the original conflict error
    // propagates and nothing is uploaded.
    expect(error).toBeInstanceOf(CliError);
    expect(state.calls).not.toContain("upload:assets/a.js.map");
  });

  it("aborts before any upload when conflicts exist", async () => {
    const state: FakeClientState = {
      calls: [],
      createBehavior: "exists",
      verdicts: { "assets/a.js": "conflict" },
      failUploadPath: null,
    };
    const captured = writers();
    let error: unknown;
    try {
      await runSourcemapsUpload(runArgs(state, captured, scannedFixture()));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("conflicting");
    expect(state.calls.filter((c) => c.startsWith("upload:"))).toEqual([]);
    expect(captured.err.join("\n")).toContain("assets/a.js");
    expect(captured.out.join("\n")).toContain("Uploaded: 0");
  });

  it("fails when no source maps are found", async () => {
    const state: FakeClientState = {
      calls: [],
      createBehavior: "created",
      verdicts: {},
      failUploadPath: null,
    };
    const captured = writers();
    await expect(
      runSourcemapsUpload(runArgs(state, captured, [])),
    ).rejects.toBeInstanceOf(CliError);
    expect(state.calls).toEqual([]);
  });

  it("emits clean JSON with per-artifact statuses", async () => {
    const state: FakeClientState = {
      calls: [],
      createBehavior: "created",
      verdicts: { "assets/a.js": "exists" },
      failUploadPath: null,
    };
    const captured = writers();
    await runSourcemapsUpload({
      ...runArgs(state, captured, scannedFixture()),
      json: true,
    });
    expect(captured.out).toHaveLength(1);
    const parsed = JSON.parse(captured.out[0] as string) as {
      release: { version: string; created: boolean };
      found: { sourceMaps: number; minifiedAssets: number };
      uploaded: number;
      alreadyPresent: number;
      artifacts: Array<{ status: string }>;
    };
    expect(parsed.release).toEqual({ version: "web@1.0.0", created: true });
    expect(parsed.found).toEqual({ sourceMaps: 1, minifiedAssets: 1 });
    expect(parsed.uploaded).toBe(1);
    expect(parsed.alreadyPresent).toBe(1);
    expect(parsed.artifacts.map((a) => a.status).sort()).toEqual([
      "already-present",
      "uploaded",
    ]);
  });
});
