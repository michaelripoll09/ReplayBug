/**
 * RS-07 `replaybug` program: established lightweight parsing via
 * `commander` (no fragile custom parser).
 *
 * Binary surface: `replaybug` (Node 24) with `projects info`,
 * `releases create <version> [--commit-sha --repository-url]`,
 * `releases list [--json]`, and `sourcemaps upload <dir> --release
 * <version> [--json?]`. Shared `--api-url` falls back to
 * `REPLAYBUG_API_URL`; auth is exclusively `REPLAYBUG_AUTH_TOKEN` —
 * there is intentionally no `--token` option.
 *
 * The factory takes its collaborators as arguments so unit tests drive
 * parsing, validation, and output without touching the network or disk.
 */
import { Command } from "commander";
import { API_URL_ENV_VAR, requireAuthToken, resolveApiUrl } from "./config.js";
import {
  runProjectsInfo,
  runReleasesCreate,
  runReleasesList,
  runSourcemapsUpload,
  type CommandWriters,
} from "./commands.js";
import type { CliApiClient } from "./client.js";
import type { ScanResult } from "./scanner.js";

export interface ProgramDeps {
  version: string;
  createClient: (options: { apiUrl: string; token: string }) => CliApiClient;
  scanDirectory: (root: string) => Promise<ScanResult>;
  stdout?: ((line: string) => void) | undefined;
  stderr?: ((line: string) => void) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

interface HandlerContext {
  client: CliApiClient;
  json: boolean;
  writers: CommandWriters;
}

function readGlobalOptions(command: Command): {
  apiUrl: string | undefined;
} {
  const globals = command.optsWithGlobals() as {
    apiUrl?: unknown;
  };
  const apiUrl = globals.apiUrl;
  if (apiUrl !== undefined && typeof apiUrl !== "string") {
    throw new Error("Invalid --api-url value");
  }
  return { apiUrl };
}

function readJsonFlag(command: Command): boolean {
  const local = command.opts() as { json?: unknown };
  return local.json === true;
}

export function createProgram(deps: ProgramDeps): Command {
  const env = deps.env ?? process.env;
  const writers: CommandWriters = {
    stdout: deps.stdout ?? ((line: string): void => console.log(line)),
    stderr: deps.stderr ?? ((line: string): void => console.error(line)),
  };

  function buildContext(command: Command, json: boolean): HandlerContext {
    const { apiUrl: apiUrlOption } = readGlobalOptions(command);
    const apiUrl = resolveApiUrl(apiUrlOption, env);
    const token = requireAuthToken(env);
    return { client: deps.createClient({ apiUrl, token }), json, writers };
  }

  const program = new Command();
  program
    .name("replaybug")
    .description("Developer observability for reproducible bugs.")
    .version(deps.version)
    .option(
      "--api-url <url>",
      `API base URL (default: $${API_URL_ENV_VAR} or http://localhost:4001)`,
    );

  const projects = program
    .command("projects")
    .description("Inspect project-scoped resources");
  projects
    .command("info")
    .description("Show the project authenticated by REPLAYBUG_AUTH_TOKEN")
    .option("--json", "Print the project as JSON")
    .action(async (_options: unknown, command: Command): Promise<void> => {
      const context = buildContext(command, readJsonFlag(command));
      await runProjectsInfo({
        client: context.client,
        json: context.json,
        writers,
      });
    });

  const releases = program
    .command("releases")
    .description("Manage project releases");
  releases
    .command("create")
    .description(
      "Create a release (idempotent: identical re-creates report already exists)",
    )
    .argument("<version>", "Release version (for example web@1.4.2)")
    .option("--commit-sha <sha>", "Commit SHA recorded for the release")
    .option("--repository-url <url>", "Repository URL recorded for the release")
    .option("--json", "Print the release as JSON")
    .action(
      async (
        version: string,
        options: { commitSha?: unknown; repositoryUrl?: unknown },
        command: Command,
      ): Promise<void> => {
        const context = buildContext(command, readJsonFlag(command));
        await runReleasesCreate({
          client: context.client,
          version,
          commitSha:
            typeof options.commitSha === "string"
              ? options.commitSha
              : undefined,
          repositoryUrl:
            typeof options.repositoryUrl === "string"
              ? options.repositoryUrl
              : undefined,
          json: context.json,
          writers,
        });
      },
    );
  releases
    .command("list")
    .description("List releases in deterministic order")
    .option("--json", "Print the releases as JSON")
    .action(async (_options: unknown, command: Command): Promise<void> => {
      const context = buildContext(command, readJsonFlag(command));
      await runReleasesList({
        client: context.client,
        json: context.json,
        writers,
      });
    });

  const sourcemaps = program
    .command("sourcemaps")
    .description("Upload source maps and minified assets");
  sourcemaps
    .command("upload")
    .description(
      "Scan a build directory and upload source maps with their minified assets",
    )
    .argument("<directory>", "Build output directory holding .map files")
    .requiredOption("--release <version>", "Release version to upload to")
    .option("--json", "Print the upload summary as JSON")
    .action(
      async (
        directory: string,
        options: { release?: unknown },
        command: Command,
      ): Promise<void> => {
        const context = buildContext(command, readJsonFlag(command));
        const release =
          typeof options.release === "string" ? options.release : "";
        await runSourcemapsUpload({
          client: context.client,
          scan: deps.scanDirectory,
          directory,
          version: release,
          json: context.json,
          writers,
        });
      },
    );

  return program;
}
