"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import { secretTokensQuery, useInvalidateDomain } from "@/lib/queries";
import { canManageSecretTokens, type WorkspaceRole } from "@/lib/rbac";
import { toUiError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RouteSkeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface RevealedToken {
  id: string;
  name: string;
  prefix: string;
  token: string;
}

function isForbidden(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "FORBIDDEN" || error.status === 403)
  );
}

/**
 * Secret project tokens (CLI/CI-only).
 *
 * Separate from the browser-safe public ingest key above: secret tokens
 * drive `replaybug` CLI automation (releases, source-map uploads) and must
 * never appear in frontend code or ship to browsers. Owner/admin create and
 * revoke; member/viewer hit the RS-02 403-on-all policy (including list) and
 * get a graceful read-only notice instead of controls.
 *
 * Plaintext hygiene: the created token lives in component memory only. It
 * is never written to localStorage/sessionStorage, the URL, or the TanStack
 * Query cache (creation bypasses query caching; only targeted list
 * invalidation runs), and closing the reveal dialog clears it.
 */
export function SecretTokensSettings({
  projectId,
  role,
}: {
  projectId: string;
  role: WorkspaceRole;
}): React.JSX.Element {
  const { invalidateSecretTokens } = useInvalidateDomain();
  const tokens = useQuery(secretTokensQuery(projectId));
  const [name, setName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [revealed, setRevealed] = React.useState<RevealedToken | null>(null);
  const [revealOpen, setRevealOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const canManage = canManageSecretTokens(role);

  // The revealed plaintext must never survive navigation or remount.
  React.useEffect(() => {
    return () => setRevealed(null);
  }, []);

  function closeReveal(): void {
    // Closing clears the plaintext mutation state immediately.
    setRevealed(null);
    setRevealOpen(false);
    setCopied(false);
  }

  async function create(): Promise<void> {
    setError(null);
    setCreating(true);
    setRevealed(null);
    try {
      const {
        data: created,
        error: apiError,
        response,
      } = await api.client.POST("/api/v1/projects/{projectId}/secret-tokens", {
        params: { path: { projectId } },
        body: { name: name.trim() },
      });
      if (apiError !== undefined || created === undefined) {
        throw await api.unwrap({ data: created, error: apiError, response });
      }
      // Targeted list invalidation only. The creation response (which
      // carries the one-time plaintext) is never written to the query
      // cache, storage, or the URL — it stays in component memory.
      await invalidateSecretTokens(projectId);
      setName("");
      setRevealed({
        id: created.id,
        name: created.name,
        prefix: created.prefix,
        token: created.token,
      });
      setCopied(false);
      setRevealOpen(true);
    } catch (e) {
      setError(
        e instanceof ApiError ? toUiError(e).message : "Creation failed.",
      );
    } finally {
      setCreating(false);
    }
  }

  async function revoke(tokenId: string): Promise<void> {
    setError(null);
    setRevokingId(tokenId);
    try {
      const {
        data,
        error: apiError,
        response,
      } = await api.client.POST(
        "/api/v1/projects/{projectId}/secret-tokens/{tokenId}/revoke",
        { params: { path: { projectId, tokenId } } },
      );
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      await invalidateSecretTokens(projectId);
    } catch (e) {
      setError(
        e instanceof ApiError ? toUiError(e).message : "Revocation failed.",
      );
    } finally {
      setRevokingId(null);
    }
  }

  async function copy(): Promise<void> {
    if (revealed === null) {
      return;
    }
    try {
      await navigator.clipboard.writeText(revealed.token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (tokens.isPending) {
    return <RouteSkeleton lines={2} />;
  }

  // RS-02 403-on-all: member/viewer cannot list — render the graceful
  // read-only notice, never creation controls or a crash.
  if (isForbidden(tokens.error)) {
    return (
      <Alert title="Secret tokens are restricted">
        Your role ({role}) cannot view secret project tokens. Owners and admins
        manage CLI/CI credentials here; the public ingest key above stays
        available to every role.
      </Alert>
    );
  }

  if (tokens.isError || tokens.data === undefined) {
    return (
      <Alert variant="destructive" title="Could not load secret tokens">
        Please try again.
        <span className="mt-2 block">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void tokens.refetch()}
          >
            Retry
          </Button>
        </span>
      </Alert>
    );
  }

  const items = tokens.data;

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Secret project tokens are CLI/CI-only credentials for{" "}
        <span className="font-mono text-xs">replaybug</span> automation
        (releases, source-map uploads). Never put them in frontend code or ship
        them to browsers — the public ingest key above is the only browser-safe
        key.
      </p>
      {!canManage ? (
        <Alert title="Read-only">
          Your role ({role}) can view token metadata but cannot create or revoke
          secret tokens.
        </Alert>
      ) : null}
      {error !== null ? (
        <Alert variant="destructive" title="Secret tokens">
          {error}
        </Alert>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Name
              </th>
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
              {canManage ? (
                <th scope="col" className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr className="border-t border-zinc-200 dark:border-zinc-800">
                <td
                  colSpan={canManage ? 6 : 5}
                  className="px-4 py-3 text-sm text-zinc-500"
                >
                  No secret tokens yet.
                </td>
              </tr>
            ) : (
              items.map((t) => (
                <tr
                  key={t.id}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td className="px-4 py-2">{t.name}</td>
                  <td className="px-4 py-2 font-mono text-xs">{t.prefix}</td>
                  <td className="px-4 py-2">
                    {t.revokedAt != null ? (
                      <Badge variant="outline">Revoked</Badge>
                    ) : (
                      <Badge>Active</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-zinc-500">
                    {formatDateTime(t.createdAt)}
                  </td>
                  <td className="px-4 py-2 text-xs text-zinc-500">
                    {t.lastUsedAt != null
                      ? formatDateTime(t.lastUsedAt)
                      : "Never"}
                  </td>
                  {canManage ? (
                    <td className="px-4 py-2">
                      {t.revokedAt == null ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-label={`Revoke token ${t.name}`}
                          disabled={revokingId === t.id}
                          onClick={() => void revoke(t.id)}
                        >
                          {revokingId === t.id ? "Revoking…" : "Revoke"}
                        </Button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Only metadata is shown here. Full tokens are revealed once at creation
        and hashes never leave the server.
      </p>
      {canManage ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="secret-token-name">Token name</Label>
            <Input
              id="secret-token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ci-upload"
              maxLength={100}
              autoComplete="off"
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={creating || name.trim() === ""}
          >
            {creating ? "Creating…" : "Create secret token"}
          </Button>
        </form>
      ) : null}
      <Dialog
        open={revealOpen}
        onOpenChange={(open) => {
          if (!open) {
            closeReveal();
          } else {
            setRevealOpen(true);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Secret token created</DialogTitle>
            <DialogDescription>
              Copy it now — this value is shown once and will never be displayed
              again.
            </DialogDescription>
          </DialogHeader>
          {revealed !== null ? (
            <div className="space-y-3">
              <p className="text-sm">
                Token <span className="font-medium">{revealed.name}</span>{" "}
                <span className="font-mono text-xs text-zinc-500">
                  ({revealed.prefix})
                </span>
              </p>
              <code className="block overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs break-all dark:bg-zinc-900">
                {revealed.token}
              </code>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Use it as{" "}
                <span className="font-mono">REPLAYBUG_AUTH_TOKEN</span> in your
                CLI/CI environment. Never commit it to version control or embed
                it in frontend code.
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => void copy()}
              disabled={revealed === null}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button type="button" onClick={closeReveal}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
