"use client";

import { formatDateTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";

export interface ReleaseArtifactItem {
  id: string;
  artifactPath: string;
  artifactType: "source_map" | "minified_asset";
  contentHash: string;
  sizeBytes: number;
  createdAt: string;
}

function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KiB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * Release artifact list (pure): paths + status as escaped monospace text.
 * Metadata only (path/type/hash/size) — artifact bytes and source-map
 * contents are never fetched or rendered.
 */
export function ReleaseArtifactsTable({
  artifacts,
}: {
  artifacts: ReleaseArtifactItem[];
}): React.JSX.Element {
  if (artifacts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
        <p className="font-medium">No artifacts uploaded</p>
        <p className="mt-1 text-sm text-zinc-500">
          Upload source maps and minified assets with{" "}
          <span className="font-mono text-xs">replaybug sourcemaps upload</span>
          .
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
              Path
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Type
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Status
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Size
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              SHA-256
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Uploaded
            </th>
          </tr>
        </thead>
        <tbody>
          {artifacts.map((artifact) => (
            <tr
              key={artifact.id}
              className="border-t border-zinc-200 dark:border-zinc-800"
            >
              <td className="px-4 py-2 font-mono text-xs">
                {artifact.artifactPath}
              </td>
              <td className="px-4 py-2">
                <Badge variant="outline">
                  {artifact.artifactType === "source_map"
                    ? "Source map"
                    : "Minified asset"}
                </Badge>
              </td>
              <td className="px-4 py-2">
                <Badge>Stored</Badge>
              </td>
              <td className="px-4 py-2 font-mono text-xs">
                {formatBytes(artifact.sizeBytes)}
              </td>
              <td
                className="px-4 py-2 font-mono text-xs"
                title={artifact.contentHash}
              >
                {artifact.contentHash.slice(0, 12)}…
              </td>
              <td className="px-4 py-2 text-xs text-zinc-500">
                {formatDateTime(artifact.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
