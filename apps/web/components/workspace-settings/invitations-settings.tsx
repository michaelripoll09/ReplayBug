"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import {
  type WorkspaceInvitation,
  type WorkspaceMemberRole,
  useInvalidateDomain,
  workspaceInvitationsQuery,
} from "@/lib/queries";
import { canInviteRole, canManageInvitations } from "@/lib/rbac";
import { toUiError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { useWorkspaceSettings } from "./workspace-settings-context";

const invitationRoles = [
  "admin",
  "member",
  "viewer",
] as const satisfies readonly WorkspaceMemberRole[];

export function normalizeInvitationEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidInvitationEmail(value: string): boolean {
  const email = normalizeInvitationEmail(value);
  return (
    email.length >= 3 &&
    email.length <= 320 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)
  );
}

function invitationStatusVariant(
  status: WorkspaceInvitation["status"],
): "default" | "secondary" | "outline" {
  if (status === "pending") {
    return "default";
  }
  if (status === "revoked") {
    return "outline";
  }
  return "secondary";
}

function mutationMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? toUiError(cause).message : fallback;
}

interface OneTimeInviteReveal {
  email: string;
  role: WorkspaceMemberRole;
  token: string;
  inviteUrl: string;
}

export function InvitationsSettings(): React.JSX.Element {
  const { workspaceId, role } = useWorkspaceSettings();
  const canManage = canManageInvitations(role);
  const invitationsQuery = useQuery({
    ...workspaceInvitationsQuery(workspaceId),
    enabled: canManage,
  });
  const { invalidateWorkspaceInvitations, invalidateWorkspaceAudit } =
    useInvalidateDomain();
  const [email, setEmail] = React.useState("");
  const [inviteRole, setInviteRole] =
    React.useState<WorkspaceMemberRole>("member");
  const [emailError, setEmailError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [revokingId, setRevokingId] = React.useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] =
    React.useState<WorkspaceInvitation | null>(null);
  const [reveal, setReveal] = React.useState<OneTimeInviteReveal | null>(null);
  const [revealOpen, setRevealOpen] = React.useState(false);
  const [copied, setCopied] = React.useState<"token" | "url" | null>(null);
  const emailId = React.useId();

  React.useEffect(() => {
    return () => setReveal(null);
  }, []);

  function closeReveal(): void {
    setReveal(null);
    setRevealOpen(false);
    setCopied(null);
  }

  async function copyReveal(value: "token" | "url"): Promise<void> {
    if (reveal === null) {
      return;
    }
    const text = value === "token" ? reveal.token : reveal.inviteUrl;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(value);
    } catch {
      setCopied(null);
    }
  }

  async function createInvitation(): Promise<void> {
    const normalizedEmail = normalizeInvitationEmail(email);
    setEmailError(
      isValidInvitationEmail(normalizedEmail)
        ? null
        : "Enter a valid email address.",
    );
    setError(null);
    setStatus(null);
    if (
      !isValidInvitationEmail(normalizedEmail) ||
      !canInviteRole(role, inviteRole)
    ) {
      return;
    }

    setCreating(true);
    setReveal(null);
    try {
      const {
        data,
        error: apiError,
        response,
      } = await api.client.POST(
        "/api/v1/workspaces/{workspaceId}/invitations",
        {
          params: { path: { workspaceId } },
          body: { email: normalizedEmail, role: inviteRole },
        },
      );
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      await Promise.all([
        invalidateWorkspaceInvitations(workspaceId),
        invalidateWorkspaceAudit(workspaceId),
      ]);
      setEmail("");
      setReveal({
        email: data.email,
        role: data.role,
        token: data.token,
        inviteUrl: data.inviteUrl,
      });
      setCopied(null);
      setRevealOpen(true);
    } catch (cause) {
      setError(mutationMessage(cause, "The invitation could not be created."));
    } finally {
      setCreating(false);
    }
  }

  async function revokeInvitation(): Promise<void> {
    if (revokeTarget === null) {
      return;
    }
    setError(null);
    setStatus(null);
    setRevokingId(revokeTarget.id);
    try {
      const {
        data,
        error: apiError,
        response,
      } = await api.client.DELETE(
        "/api/v1/workspaces/{workspaceId}/invitations/{invitationId}",
        {
          params: {
            path: { workspaceId, invitationId: revokeTarget.id },
          },
        },
      );
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      await Promise.all([
        invalidateWorkspaceInvitations(workspaceId),
        invalidateWorkspaceAudit(workspaceId),
      ]);
      setStatus(`Invitation for ${revokeTarget.email} was revoked.`);
      setRevokeTarget(null);
    } catch (cause) {
      setError(mutationMessage(cause, "The invitation could not be revoked."));
    } finally {
      setRevokingId(null);
    }
  }

  if (!canManage) {
    return (
      <Alert title="Invitations are restricted">
        Your role ({role}) can view workspace settings but cannot create or
        revoke invitations. Owners and admins manage invitation access here.
      </Alert>
    );
  }

  if (invitationsQuery.isPending) {
    return <RouteSkeleton lines={4} />;
  }
  if (invitationsQuery.isError || invitationsQuery.data === undefined) {
    return (
      <Alert variant="destructive" title="Could not load invitations">
        Please try again.
        <span className="mt-2 block">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void invitationsQuery.refetch()}
          >
            Retry
          </Button>
        </span>
      </Alert>
    );
  }

  const invitations = invitationsQuery.data;

  return (
    <div className="space-y-5">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Create management-only invitations. No email is sent; the plaintext
        token and invite URL are shown exactly once after creation.
      </p>
      {error !== null ? (
        <Alert variant="destructive" title="Invitation management">
          {error}
        </Alert>
      ) : null}
      {status !== null ? (
        <Alert title="Invitation management">
          <span role="status">{status}</span>
        </Alert>
      ) : null}
      <form
        className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        onSubmit={(event) => {
          event.preventDefault();
          void createInvitation();
        }}
        noValidate
      >
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_12rem_auto] md:items-end">
          <div className="space-y-2">
            <Label htmlFor={emailId}>Invite email</Label>
            <Input
              id={emailId}
              type="email"
              value={email}
              autoComplete="off"
              inputMode="email"
              aria-invalid={emailError !== null}
              aria-describedby={
                emailError !== null ? `${emailId}-error` : undefined
              }
              onChange={(event) => setEmail(event.target.value)}
              placeholder="person@example.com"
            />
            {emailError !== null ? (
              <p
                id={`${emailId}-error`}
                role="alert"
                className="text-sm text-red-600 dark:text-red-400"
              >
                {emailError}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="invitation-role">Role</Label>
            <select
              id="invitation-role"
              className="h-9 w-full rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
              value={inviteRole}
              onChange={(event) => {
                const nextRole = event.target.value;
                if (invitationRoles.includes(nextRole as WorkspaceMemberRole)) {
                  setInviteRole(nextRole as WorkspaceMemberRole);
                }
              }}
            >
              {invitationRoles
                .filter((candidate) => canInviteRole(role, candidate))
                .map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate[0]?.toUpperCase() + candidate.slice(1)}
                  </option>
                ))}
            </select>
          </div>
          <Button type="submit" disabled={creating}>
            {creating ? "Creating…" : "Create invitation"}
          </Button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Admins may invite members and viewers. Only owners may invite admins.
        </p>
      </form>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Email
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Role
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Status
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Token prefix
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Expires
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {invitations.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-4 text-sm text-zinc-500">
                  No invitations yet.
                </td>
              </tr>
            ) : (
              invitations.map((invitation) => (
                <tr
                  key={invitation.id}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td className="px-4 py-3">{invitation.email}</td>
                  <td className="px-4 py-3">{invitation.role}</td>
                  <td className="px-4 py-3">
                    <Badge variant={invitationStatusVariant(invitation.status)}>
                      {invitation.status}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {invitation.tokenPrefix}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {formatDateTime(invitation.expiresAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {invitation.status === "pending" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={revokingId !== null}
                        onClick={() => setRevokeTarget(invitation)}
                      >
                        {revokingId === invitation.id ? "Revoking…" : "Revoke"}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Only safe metadata is listed. Invitation tokens and URLs are never
        stored in React Query, browser storage, or the URL.
      </p>

      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open && revokingId === null) {
            setRevokeTarget(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke invitation?</DialogTitle>
            <DialogDescription>
              The invitation will no longer be accepted. This action is audited
              by the backend.
            </DialogDescription>
          </DialogHeader>
          {revokeTarget !== null ? (
            <p className="text-sm">
              Revoke the invitation for <strong>{revokeTarget.email}</strong>?
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={revokingId !== null}
              onClick={() => setRevokeTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={revokingId !== null || revokeTarget === null}
              onClick={() => void revokeInvitation()}
            >
              {revokingId !== null ? "Revoking…" : "Revoke invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <DialogTitle>Invitation created — save this now</DialogTitle>
            <DialogDescription>
              This plaintext token and URL are shown once. Save them now; they
              will not be placed in the query cache, browser storage, or URL.
            </DialogDescription>
          </DialogHeader>
          {reveal !== null ? (
            <div className="space-y-4">
              <p className="text-sm">
                {reveal.email} · {reveal.role}
              </p>
              <div className="space-y-2">
                <Label htmlFor="one-time-invitation-token">
                  Invitation token
                </Label>
                <code
                  id="one-time-invitation-token"
                  className="block overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs break-all dark:bg-zinc-900"
                >
                  {reveal.token}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyReveal("token")}
                >
                  {copied === "token" ? "Token copied" : "Copy token"}
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor="one-time-invitation-url">Invite URL</Label>
                <code
                  id="one-time-invitation-url"
                  className="block overflow-x-auto rounded-md bg-zinc-100 p-3 font-mono text-xs break-all dark:bg-zinc-900"
                >
                  {reveal.inviteUrl}
                </code>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void copyReveal("url")}
                >
                  {copied === "url" ? "URL copied" : "Copy invite URL"}
                </Button>
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" onClick={closeReveal}>
              Close and clear
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
