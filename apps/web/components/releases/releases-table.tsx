"use client";

import Link from "next/link";
import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

export interface ReleaseListItem {
  id: string;
  version: string;
  commitSha: string | null;
  createdAt: string;
  artifactCount: number;
  sourceMapCount: number;
  minifiedAssetCount: number;
  occurrenceCount: number;
  hasSourceMaps: boolean;
}

function shortCommit(commitSha: string | null): string {
  if (commitSha === null || commitSha === "") {
    return "—";
  }
  return commitSha.slice(0, 7);
}

/**
 * Release list (pure): version/commit/created/occurrences plus source-map
 * and artifact counts. Links to detail; never renders map contents (the API
 * exposes metadata only).
 */
export function ReleasesTable({
  projectId,
  items,
}: {
  projectId: string;
  items: ReleaseListItem[];
}): React.JSX.Element {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
        <p className="font-medium">No releases yet</p>
        <p className="mt-1 text-sm text-zinc-500">
          Register a release and upload source maps with the{" "}
          <span className="font-mono text-xs">replaybug</span> CLI. Releases
          appear here once created.
        </p>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900">
          <tr>
            <th scope="col" className="px-4 py-2 font-medium">
              Version
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Commit
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Created
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Occurrences
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Source maps
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Artifacts
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              className="border-t border-zinc-200 dark:border-zinc-800"
            >
              <td className="px-4 py-2 font-mono text-xs">
                <Link
                  href={`/app/projects/${projectId}/releases/${item.id}`}
                  className="underline"
                >
                  {item.version}
                </Link>
              </td>
              <td
                className="px-4 py-2 font-mono text-xs"
                title={item.commitSha ?? undefined}
              >
                {shortCommit(item.commitSha)}
              </td>
              <td className="px-4 py-2 text-xs text-zinc-500">
                {formatDateTime(item.createdAt)}
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                {item.occurrenceCount}
              </td>
              <td className="px-4 py-2">
                {item.hasSourceMaps ? (
                  <Badge>
                    <span className="font-mono text-xs">
                      {item.sourceMapCount} mapped
                    </span>
                  </Badge>
                ) : (
                  <Badge variant="outline">No maps</Badge>
                )}
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                {item.artifactCount} ({item.minifiedAssetCount} assets)
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
