/**
 * RS-07 command handlers: thin orchestration over the network client and
 * the scanner, with human-readable output by default and `--json` where
 * clean. All output flows through the injected `stdout`/`stderr`
 * writers so tests capture everything; the token never appears in any
 * line these handlers print.
 */
import { CliError } from "./errors.js";
import type {
  CliApiClient,
  PreflightResult,
  UploadArtifactType,
} from "./client.js";
import type { ScannedArtifact, ScanResult } from "./scanner.js";

export interface CommandWriters {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

export interface ProjectsInfoArgs {
  client: CliApiClient;
  json: boolean;
  writers: CommandWriters;
}

export async function runProjectsInfo(args: ProjectsInfoArgs): Promise<void> {
  const info = await args.client.getProject();
  if (args.json) {
    args.writers.stdout(
      JSON.stringify(
        {
          project: {
            id: info.projectId,
            name: info.projectName,
            slug: info.projectSlug,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            timezone: info.timezone,
          },
        },
        null,
        2,
      ),
    );
    return;
  }
  args.writers.stdout(`Project: ${info.projectName} (${info.projectSlug})`);
  args.writers.stdout(`Project ID: ${info.projectId}`);
  args.writers.stdout(`Workspace: ${info.workspaceName} (${info.workspaceId})`);
  args.writers.stdout(`Timezone: ${info.timezone}`);
}

export interface ReleasesCreateArgs {
  client: CliApiClient;
  version: string;
  commitSha: string | undefined;
  repositoryUrl: string | undefined;
  json: boolean;
  writers: CommandWriters;
}

export async function runReleasesCreate(
  args: ReleasesCreateArgs,
): Promise<void> {
  const result = await args.client.createRelease({
    version: args.version,
    commitSha: args.commitSha,
    repositoryUrl: args.repositoryUrl,
  });
  if (args.json) {
    args.writers.stdout(JSON.stringify(result, null, 2));
    return;
  }
  const status = result.created ? "created" : "already exists";
  args.writers.stdout(`Release "${result.release.version}" ${status}.`);
}

export interface ReleasesListArgs {
  client: CliApiClient;
  json: boolean;
  writers: CommandWriters;
}

export async function runReleasesList(args: ReleasesListArgs): Promise<void> {
  const releases = await args.client.listReleases();
  if (args.json) {
    args.writers.stdout(JSON.stringify({ releases }, null, 2));
    return;
  }
  if (releases.length === 0) {
    args.writers.stdout("No releases found.");
    return;
  }
  for (const release of releases) {
    const commit = release.commit ?? "-";
    const artifacts =
      release.artifactCount === 1
        ? "1 artifact"
        : `${release.artifactCount} artifacts`;
    args.writers.stdout(
      `${release.version} — ${artifacts}, commit ${commit}, created ${release.createdAt}`,
    );
  }
}

export interface UploadSourcemapsArgs {
  client: CliApiClient;
  scan: (root: string) => Promise<ScanResult>;
  directory: string;
  version: string;
  json: boolean;
  writers: CommandWriters;
}

export interface UploadPlan {
  toUpload: ScannedArtifact[];
  alreadyPresent: ScannedArtifact[];
  conflicts: ScannedArtifact[];
}

/**
 * Pure preflight planner: split scanned artifacts by the server
 * verdicts. Results the server did not ask about are ignored; scanned
 * files missing from the results are treated as uploads (fail-safe
 * toward uploading rather than silently dropping).
 */
export function planUploads(
  scanned: ScannedArtifact[],
  results: PreflightResult[],
): UploadPlan {
  const byPath = new Map<string, PreflightResult>();
  for (const result of results) {
    byPath.set(result.artifactPath, result);
  }
  const plan: UploadPlan = { toUpload: [], alreadyPresent: [], conflicts: [] };
  for (const artifact of scanned) {
    const verdict = byPath.get(artifact.artifactPath)?.verdict ?? "upload";
    if (verdict === "exists") {
      plan.alreadyPresent.push(artifact);
    } else if (verdict === "conflict") {
      plan.conflicts.push(artifact);
    } else {
      plan.toUpload.push(artifact);
    }
  }
  return plan;
}

function countByType(
  artifacts: ScannedArtifact[],
  type: UploadArtifactType,
): number {
  return artifacts.filter((artifact) => artifact.artifactType === type).length;
}

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 ${singular}` : `${count} ${plural}`;
}

export async function runSourcemapsUpload(
  args: UploadSourcemapsArgs,
): Promise<void> {
  const scan = await args.scan(args.directory);
  for (const warning of scan.warnings) {
    args.writers.stderr(`Warning: ${warning}`);
  }
  const foundMaps = countByType(scan.artifacts, "source_map");
  if (foundMaps === 0) {
    throw new CliError(
      `No source maps found in "${args.directory}". Nothing to upload.`,
      {
        hint: "Point the command at the build output directory that holds the .map files (for example ./dist).",
      },
    );
  }
  const foundAssets = countByType(scan.artifacts, "minified_asset");

  const release = await createOrConfirmRelease(
    args.client,
    args.version,
    args.writers,
    args.json,
  );

  const results = await args.client.checkPreflight(
    args.version,
    scan.artifacts.map((artifact) => ({
      artifactPath: artifact.artifactPath,
      artifactType: artifact.artifactType,
      contentHash: artifact.contentHash,
      sizeBytes: artifact.sizeBytes,
    })),
  );
  const plan = planUploads(scan.artifacts, results);

  if (plan.conflicts.length > 0) {
    const details = plan.conflicts
      .map(
        (artifact) =>
          `  ${artifact.artifactPath}: stored content differs — refusing to overwrite.`,
      )
      .join("\n");
    args.writers.stderr(
      `Release "${args.version}" has ${pluralize(plan.conflicts.length, "conflicting artifact", "conflicting artifacts")}:\n${details}`,
    );
    printUploadSummary(args, {
      created: release.created,
      foundMaps,
      foundAssets,
      uploaded: 0,
      alreadyPresent: plan.alreadyPresent.length,
      uploadedArtifacts: [],
      presentArtifacts: plan.alreadyPresent,
    });
    throw new CliError(
      `Upload aborted: ${plan.conflicts.length} conflicting artifact(s) in release "${args.version}". No files were uploaded and stored bytes are unchanged.`,
      {
        hint: "Restore the matching file contents, or upload the changed files under a new release version.",
      },
    );
  }

  const uploadedArtifacts: ScannedArtifact[] = [];
  for (const artifact of plan.toUpload) {
    await args.client.uploadArtifact(args.version, {
      artifactPath: artifact.artifactPath,
      artifactType: artifact.artifactType,
      absolutePath: artifact.absolutePath,
    });
    uploadedArtifacts.push(artifact);
  }

  printUploadSummary(args, {
    created: release.created,
    foundMaps,
    foundAssets,
    uploaded: uploadedArtifacts.length,
    alreadyPresent: plan.alreadyPresent.length,
    uploadedArtifacts,
    presentArtifacts: plan.alreadyPresent,
  });
}

/**
 * Create-or-confirm the release: an idempotent create wins the common
 * case; a RELEASE_VERSION_CONFLICT just means the version already
 * exists with different identity metadata (fine for upload purposes),
 * so existence is confirmed via the list and the run continues.
 */
async function createOrConfirmRelease(
  client: CliApiClient,
  version: string,
  writers: CommandWriters,
  json: boolean,
): Promise<{ created: boolean }> {
  try {
    const result = await client.createRelease({ version });
    return { created: result.created };
  } catch (error) {
    if (
      error instanceof CliError &&
      error.serverCode === "RELEASE_VERSION_CONFLICT"
    ) {
      const releases = await client.listReleases();
      const existing = releases.find((release) => release.version === version);
      if (existing !== undefined) {
        if (!json) {
          writers.stdout(`Release "${version}" already exists; using it.`);
        }
        return { created: false };
      }
    }
    throw error;
  }
}

interface UploadSummary {
  created: boolean;
  foundMaps: number;
  foundAssets: number;
  uploaded: number;
  alreadyPresent: number;
  uploadedArtifacts: ScannedArtifact[];
  presentArtifacts: ScannedArtifact[];
}

function printUploadSummary(
  args: UploadSourcemapsArgs,
  summary: UploadSummary,
): void {
  if (args.json) {
    args.writers.stdout(
      JSON.stringify(
        {
          release: { version: args.version, created: summary.created },
          found: {
            sourceMaps: summary.foundMaps,
            minifiedAssets: summary.foundAssets,
          },
          uploaded: summary.uploaded,
          alreadyPresent: summary.alreadyPresent,
          artifacts: [
            ...summary.uploadedArtifacts.map((artifact) => ({
              artifactPath: artifact.artifactPath,
              artifactType: artifact.artifactType,
              status: "uploaded",
              contentHash: artifact.contentHash,
              sizeBytes: artifact.sizeBytes,
            })),
            ...summary.presentArtifacts.map((artifact) => ({
              artifactPath: artifact.artifactPath,
              artifactType: artifact.artifactType,
              status: "already-present",
              contentHash: artifact.contentHash,
              sizeBytes: artifact.sizeBytes,
            })),
          ],
        },
        null,
        2,
      ),
    );
    return;
  }
  args.writers.stdout(
    `Found: ${pluralize(summary.foundMaps, "source map", "source maps")} / ${pluralize(summary.foundAssets, "minified asset", "minified assets")}`,
  );
  args.writers.stdout(`Uploaded: ${summary.uploaded}`);
  args.writers.stdout(`Already present: ${summary.alreadyPresent}`);
}
