import { describe, expect, it } from "vitest";
import { createProgram, type ProgramDeps } from "./program.js";
import { CliError } from "./errors.js";
import type { CliApiClient } from "./client.js";
import type { ScanResult } from "./scanner.js";

const TOKEN = "rb_sk_program_test_token_value";
const API_URL = "http://127.0.0.1:9";

interface Harness {
  out: string[];
  err: string[];
  calls: string[];
  program: ReturnType<typeof createProgram>;
}

interface FakeOptions {
  createBehavior?: "created" | "exists";
  verdicts?: Record<string, "upload" | "exists" | "conflict">;
}

function fakeClient(calls: string[], options: FakeOptions): CliApiClient {
  return {
    async getProject() {
      calls.push("getProject");
      return {
        projectId: "p1",
        projectName: "Shop",
        projectSlug: "shop",
        workspaceId: "w1",
        workspaceName: "Acme",
        timezone: "UTC",
      };
    },
    async createRelease(input) {
      calls.push(`create:${input.version}`);
      return {
        release: {
          id: "r1",
          version: input.version,
          commit: (input.commitSha as string | undefined) ?? null,
          repositoryUrl: (input.repositoryUrl as string | undefined) ?? null,
          createdAt: "2026-09-18T00:00:00.000Z",
        },
        created: (options.createBehavior ?? "created") === "created",
      };
    },
    async listReleases() {
      calls.push("list");
      return [
        {
          version: "web@1.0.0",
          commit: null,
          artifactCount: 2,
          createdAt: "2026-09-18T00:00:00.000Z",
        },
      ];
    },
    async checkPreflight(_version, entries) {
      calls.push(`preflight:${entries.length}`);
      return entries.map((entry) => ({
        ...entry,
        verdict: options.verdicts?.[entry.artifactPath] ?? "upload",
      }));
    },
    async uploadArtifact(_version, file) {
      calls.push(`upload:${file.artifactPath}`);
      return { created: true };
    },
  };
}

function harness(
  env: NodeJS.ProcessEnv,
  options: FakeOptions = {},
  scan: ((root: string) => Promise<ScanResult>) | null = null,
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const deps: ProgramDeps = {
    version: "0.0.0-test",
    createClient: () => fakeClient(calls, options),
    scanDirectory:
      scan ??
      (async () => ({
        root: "/tmp",
        artifacts: [
          {
            artifactPath: "assets/a.js.map",
            artifactType: "source_map",
            absolutePath: "/tmp/assets/a.js.map",
            sizeBytes: 10,
            contentHash: "c".repeat(64),
          },
        ],
        warnings: [],
      })),
    stdout: (line: string): void => {
      out.push(line);
    },
    stderr: (line: string): void => {
      err.push(line);
    },
    env,
  };
  const program = createProgram(deps);
  program.exitOverride();
  program.configureOutput({
    writeOut: (text: string): void => {
      out.push(text.trim());
    },
    writeErr: (text: string): void => {
      err.push(text.trim());
    },
  });
  return { out, err, calls, program };
}

function tokenEnv(): NodeJS.ProcessEnv {
  return { REPLAYBUG_AUTH_TOKEN: TOKEN, REPLAYBUG_API_URL: API_URL };
}

async function run(
  harn: Harness,
  argv: string[],
): Promise<{ error: unknown; processStderr: string }> {
  // Commander reports option errors straight to process.stderr,
  // bypassing configureOutput — intercept it so tests capture the exact
  // bytes a user would see (and can prove the token is never among them).
  const chunks: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = function (chunk: unknown): boolean {
    chunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  } as typeof process.stderr.write;
  try {
    await harn.program.parseAsync(["node", "replaybug", ...argv]);
    return { error: null, processStderr: chunks.join("") };
  } catch (error) {
    return { error, processStderr: chunks.join("") };
  } finally {
    process.stderr.write = originalWrite;
  }
}

describe("program wiring", () => {
  it("runs projects info with human output", async () => {
    const harn = harness(tokenEnv());
    const { error } = await run(harn, ["projects", "info"]);
    expect(error).toBeNull();
    expect(harn.calls).toEqual(["getProject"]);
    expect(harn.out.join("\n")).toContain("Shop (shop)");
  });

  it("passes commit-sha and repository-url through on releases create", async () => {
    const harn = harness(tokenEnv());
    const { error } = await run(harn, [
      "releases",
      "create",
      "web@2.0.0",
      "--commit-sha",
      "abc123",
      "--repository-url",
      "https://example/repo",
    ]);
    expect(error).toBeNull();
    expect(harn.calls).toEqual(["create:web@2.0.0"]);
    expect(harn.out.join("\n")).toContain('Release "web@2.0.0" created.');
  });

  it("requires --release for sourcemaps upload", async () => {
    const harn = harness(tokenEnv());
    const { error, processStderr } = await run(harn, [
      "sourcemaps",
      "upload",
      "./dist",
    ]);
    expect(error).not.toBeNull();
    expect(harn.calls).toEqual([]);
    expect(processStderr).toContain("--release");
    expect(processStderr).not.toContain(TOKEN);
  });

  it("fails clearly when the token is missing", async () => {
    const harn = harness({});
    const { error } = await run(harn, ["projects", "info"]);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("REPLAYBUG_AUTH_TOKEN");
  });

  it("rejects --token without ever accepting it as input", async () => {
    const harn = harness(tokenEnv());
    const { error, processStderr } = await run(harn, [
      "projects",
      "info",
      "--token",
      "rb_sk_should_never_work",
    ]);
    expect(error).not.toBeNull();
    expect(harn.calls).toEqual([]);
    expect(processStderr).toContain("--token");
    expect(harn.out.join("\n")).not.toContain("rb_sk_should_never_work");
    expect(harn.err.join("\n")).not.toContain("rb_sk_should_never_work");
    expect(processStderr).not.toContain("rb_sk_should_never_work");
  });

  it("exposes no --token option on any command", () => {
    const harn = harness(tokenEnv());
    const seen: string[] = [];
    const visit = (command: {
      options: Array<{ long?: string }>;
      commands: unknown[];
    }): void => {
      for (const option of command.options) {
        if (typeof option.long === "string") {
          seen.push(option.long);
        }
      }
      for (const sub of command.commands as Array<{
        options: Array<{ long?: string }>;
        commands: unknown[];
      }>) {
        visit(sub);
      }
    };
    visit(
      harn.program as unknown as {
        options: Array<{ long?: string }>;
        commands: unknown[];
      },
    );
    expect(seen).not.toContain("--token");
    expect(seen).toContain("--api-url");
  });

  it("keeps the token out of all captured output, including failures", async () => {
    const failingScan = async (): Promise<ScanResult> => ({
      root: "/tmp",
      artifacts: [],
      warnings: [],
    });
    const cases: Array<{ argv: string[]; scan?: typeof failingScan }> = [
      { argv: ["projects", "info"] },
      { argv: ["releases", "list"] },
      { argv: ["releases", "list", "--json"] },
      { argv: ["releases", "create", "web@3.0.0"] },
      { argv: ["sourcemaps", "upload", "./dist", "--release", "web@3.0.0"] },
      {
        argv: ["sourcemaps", "upload", "./dist", "--release", "web@3.0.0"],
        scan: failingScan,
      },
    ];
    for (const argvCase of cases) {
      const harn = harness(tokenEnv(), {}, argvCase.scan ?? null);
      const { processStderr } = await run(harn, argvCase.argv);
      const combined = [...harn.out, ...harn.err, processStderr].join("\n");
      expect(combined).not.toContain(TOKEN);
    }
  });

  it("uploads via the release flag and prints the contract summary", async () => {
    const harn = harness(tokenEnv());
    const { error } = await run(harn, [
      "--api-url",
      API_URL,
      "sourcemaps",
      "upload",
      "./dist",
      "--release",
      "web@1.0.0",
    ]);
    expect(error).toBeNull();
    expect(harn.calls).toContain("upload:assets/a.js.map");
    expect(harn.out.join("\n")).toContain("Found:");
    expect(harn.out.join("\n")).toContain("Uploaded: 1");
    expect(harn.out.join("\n")).toContain("Already present: 0");
  });
});
