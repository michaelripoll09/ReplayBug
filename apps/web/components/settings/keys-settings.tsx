"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import { keysQuery, useInvalidateDomain } from "@/lib/queries";
import { canRotateKeys, type WorkspaceRole } from "@/lib/rbac";
import { toUiError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { OneTimeSecret } from "@/components/secrets/one-time-secret";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { RouteSkeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Public key settings: metadata only (prefix/status/created/lastUsed — never
 * hash). Rotate (owner/admin) revokes the old key and reveals the new
 * plaintext exactly once in component memory.
 */
export function KeysSettings({
  projectId,
  role,
}: {
  projectId: string;
  role: WorkspaceRole;
}): React.JSX.Element {
  const { invalidateKeys } = useInvalidateDomain();
  const { data, isPending, isError, refetch } = useQuery(keysQuery(projectId));
  const [error, setError] = React.useState<string | null>(null);
  const [rotatedSecret, setRotatedSecret] = React.useState<string | null>(null);
  const [rotating, setRotating] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const canRotate = canRotateKeys(role);

  // The rotated plaintext must never survive navigation: drop on unmount.
  React.useEffect(() => {
    return () => setRotatedSecret(null);
  }, []);

  if (isPending) {
    return <RouteSkeleton lines={2} />;
  }
  if (isError || data === undefined) {
    return (
      <Alert variant="destructive" title="Could not load keys">
        Please try again.
        <span className="mt-2 block">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
          >
            Retry
          </Button>
        </span>
      </Alert>
    );
  }

  async function rotate(): Promise<void> {
    setError(null);
    setRotating(true);
    // Drop any previous secret before revealing the new one: never keep old.
    setRotatedSecret(null);
    try {
      const {
        data: created,
        error: apiError,
        response,
      } = await api.client.POST("/api/v1/projects/{id}/keys/public/rotate", {
        params: { path: { id: projectId } },
      });
      if (apiError !== undefined || created === undefined) {
        throw await api.unwrap({ data: created, error: apiError, response });
      }
      await invalidateKeys(projectId);
      setRotatedSecret(created.key);
      setConfirmOpen(false);
    } catch (e) {
      setError(
        e instanceof ApiError ? toUiError(e).message : "Rotation failed.",
      );
    } finally {
      setRotating(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        The public ingest key is browser-safe and write-only: it lets the SDK
        send telemetry from allowed origins and cannot read anything back.
        Source-map uploads and release management need a secret project token
        instead (below) — those are CLI/CI-only and never belong in frontend
        code.
      </p>
      {!canRotate ? (
        <Alert title="Read-only">
          Your role ({role}) can view key metadata but cannot rotate keys.
        </Alert>
      ) : null}
      {error !== null ? (
        <Alert variant="destructive" title="Keys">
          {error}
        </Alert>
      ) : null}
      {rotatedSecret !== null ? (
        <OneTimeSecret
          secret={rotatedSecret}
          label="New public ingest key"
          hint="Copy it now. The previous key is revoked and this value will never be shown again."
        />
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Prefix
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Created
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Last used
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((k) => (
              <tr
                key={k.id}
                className="border-t border-zinc-200 dark:border-zinc-800"
              >
                <td className="px-4 py-2 font-mono text-xs">{k.prefix}</td>
                <td className="px-4 py-2">
                  {k.revokedAt != null ? (
                    <Badge variant="outline">Revoked</Badge>
                  ) : (
                    <Badge>Active</Badge>
                  )}
                </td>
                <td className="px-4 py-2 text-xs text-zinc-500">
                  {formatDateTime(k.createdAt)}
                </td>
                <td className="px-4 py-2 text-xs text-zinc-500">
                  {k.lastUsedAt != null
                    ? formatDateTime(k.lastUsedAt)
                    : "Never"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Only metadata is shown here. Full keys are revealed once at
        creation/rotation and hashes never leave the server.
      </p>
      {canRotate ? (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="outline" size="sm">
              Rotate public key…
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rotate the public ingest key?</DialogTitle>
              <DialogDescription>
                The current active key is revoked immediately. Update every
                deployed app with the new key.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirmOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                disabled={rotating}
                onClick={() => void rotate()}
              >
                {rotating ? "Rotating…" : "Rotate key"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
