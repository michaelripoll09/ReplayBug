"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import {
  type WorkspaceMember,
  type WorkspaceMemberRole,
  useInvalidateDomain,
  workspaceMembersQuery,
} from "@/lib/queries";
import {
  canChangeMemberRole,
  canManageMembers,
  canRemoveMember,
  canTransferOwnership,
  roleLabel,
} from "@/lib/rbac";
import { toUiError } from "@/lib/errors";
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

function isWorkspaceMemberRole(value: string): value is WorkspaceMemberRole {
  return value === "admin" || value === "member" || value === "viewer";
}

function mutationMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? toUiError(cause).message : fallback;
}

export function MembersSettings(): React.JSX.Element {
  const { workspaceId, role } = useWorkspaceSettings();
  const membersQuery = useQuery(workspaceMembersQuery(workspaceId));
  const {
    invalidateWorkspaceMembers,
    invalidateWorkspace,
    invalidateWorkspaces,
    invalidateWorkspaceAudit,
  } = useInvalidateDomain();
  const [pendingAction, setPendingAction] = React.useState<string | null>(null);
  const [roleChangeTarget, setRoleChangeTarget] = React.useState<{
    member: WorkspaceMember;
    nextRole: WorkspaceMemberRole;
  } | null>(null);
  const [roleConfirmation, setRoleConfirmation] = React.useState("");
  const [removeTarget, setRemoveTarget] =
    React.useState<WorkspaceMember | null>(null);
  const [removeConfirmation, setRemoveConfirmation] = React.useState("");
  const [transferTarget, setTransferTarget] =
    React.useState<WorkspaceMember | null>(null);
  const [transferConfirmation, setTransferConfirmation] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);

  async function invalidateMemberGovernance(): Promise<void> {
    await Promise.all([
      invalidateWorkspaceMembers(workspaceId),
      invalidateWorkspace(workspaceId),
      invalidateWorkspaces(),
      invalidateWorkspaceAudit(workspaceId),
    ]);
  }

  async function changeRole(): Promise<void> {
    const target = roleChangeTarget;
    if (
      target === null ||
      roleConfirmation !== target.member.email ||
      !canChangeMemberRole(role, target.member.role, target.nextRole)
    ) {
      return;
    }
    setError(null);
    setStatus(null);
    setPendingAction(`role:${target.member.id}`);
    try {
      const {
        data,
        error: apiError,
        response,
      } = await api.client.PATCH(
        "/api/v1/workspaces/{workspaceId}/members/{userId}",
        {
          params: { path: { workspaceId, userId: target.member.id } },
          body: { role: target.nextRole },
        },
      );
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      await invalidateMemberGovernance();
      setStatus(`${target.member.email} is now ${roleLabel(data.role)}.`);
      setRoleChangeTarget(null);
      setRoleConfirmation("");
    } catch (cause) {
      setError(mutationMessage(cause, "The member role could not be changed."));
    } finally {
      setPendingAction(null);
    }
  }

  async function removeMember(): Promise<void> {
    if (removeTarget === null || removeConfirmation !== removeTarget.email) {
      return;
    }
    if (!canRemoveMember(role, removeTarget.role)) {
      setError("Your role cannot remove this member.");
      return;
    }
    setError(null);
    setStatus(null);
    setPendingAction(`remove:${removeTarget.id}`);
    try {
      const {
        data,
        error: apiError,
        response,
      } = await api.client.DELETE(
        "/api/v1/workspaces/{workspaceId}/members/{userId}",
        {
          params: { path: { workspaceId, userId: removeTarget.id } },
        },
      );
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      await invalidateMemberGovernance();
      setStatus(`${removeTarget.email} was removed from the workspace.`);
      setRemoveTarget(null);
      setRemoveConfirmation("");
    } catch (cause) {
      setError(mutationMessage(cause, "The member could not be removed."));
    } finally {
      setPendingAction(null);
    }
  }

  async function transferOwnership(): Promise<void> {
    if (
      transferTarget === null ||
      transferConfirmation !== transferTarget.email ||
      !canTransferOwnership(role)
    ) {
      return;
    }
    setError(null);
    setStatus(null);
    setPendingAction(`transfer:${transferTarget.id}`);
    try {
      const {
        data,
        error: apiError,
        response,
      } = await api.client.POST(
        "/api/v1/workspaces/{workspaceId}/ownership-transfer",
        {
          params: { path: { workspaceId } },
          body: { userId: transferTarget.id },
        },
      );
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      await invalidateMemberGovernance();
      setStatus(`Ownership transferred to ${transferTarget.email}.`);
      setTransferTarget(null);
      setTransferConfirmation("");
    } catch (cause) {
      setError(
        mutationMessage(cause, "Workspace ownership could not be transferred."),
      );
    } finally {
      setPendingAction(null);
    }
  }

  if (membersQuery.isPending) {
    return <RouteSkeleton lines={4} />;
  }
  if (membersQuery.isError || membersQuery.data === undefined) {
    return (
      <Alert variant="destructive" title="Could not load workspace members">
        Please try again.
        <span className="mt-2 block">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void membersQuery.refetch()}
          >
            Retry
          </Button>
        </span>
      </Alert>
    );
  }

  const members = membersQuery.data;
  const canManage = canManageMembers(role);

  return (
    <div className="space-y-4">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Every workspace member can see this list. Owners and admins can manage
        only the roles and members allowed by the backend hierarchy.
      </p>
      {error !== null ? (
        <Alert variant="destructive" title="Member management">
          {error}
        </Alert>
      ) : null}
      {status !== null ? (
        <Alert title="Member management">
          <span role="status">{status}</span>
        </Alert>
      ) : null}
      {!canManage ? (
        <Alert title="Read-only members list">
          Your role ({role}) can view workspace members but cannot change roles,
          remove members, or transfer ownership.
        </Alert>
      ) : null}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-left text-sm">
          <thead className="bg-zinc-50 dark:bg-zinc-900">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">
                Member
              </th>
              <th scope="col" className="px-4 py-2 font-medium">
                Role
              </th>
              {canManage ? (
                <th scope="col" className="px-4 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const canChange = canManageMember(member);
              const canRemove = canRemoveMember(role, member.role);
              const changing = pendingAction === `role:${member.id}`;
              const removing = pendingAction === `remove:${member.id}`;
              const transferring = pendingAction === `transfer:${member.id}`;
              return (
                <tr
                  key={member.id}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium">{member.name}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {member.email}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant={
                        member.role === "owner" ? "default" : "secondary"
                      }
                    >
                      {roleLabel(member.role)}
                    </Badge>
                  </td>
                  {canManage ? (
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {canChange ? (
                          <label
                            className="sr-only"
                            htmlFor={`role-${member.id}`}
                          >
                            Change role for {member.email}
                          </label>
                        ) : null}
                        {canChange ? (
                          <select
                            id={`role-${member.id}`}
                            aria-label={`Change role for ${member.email}`}
                            className="h-8 rounded-md border border-zinc-200 bg-white px-2 text-xs dark:border-zinc-800 dark:bg-zinc-950"
                            value={member.role}
                            disabled={changing || pendingAction !== null}
                            onChange={(event) => {
                              const nextRole = event.target.value;
                              if (
                                isWorkspaceMemberRole(nextRole) &&
                                nextRole !== member.role &&
                                canChangeMemberRole(role, member.role, nextRole)
                              ) {
                                setError(null);
                                setStatus(null);
                                setRoleConfirmation("");
                                setRoleChangeTarget({ member, nextRole });
                              }
                            }}
                          >
                            <option value="admin">Admin</option>
                            <option value="member">Member</option>
                            <option value="viewer">Viewer</option>
                          </select>
                        ) : null}
                        {canRemove ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={pendingAction !== null}
                            onClick={() => {
                              setError(null);
                              setRemoveConfirmation("");
                              setRemoveTarget(member);
                            }}
                          >
                            {removing ? "Removing…" : "Remove"}
                          </Button>
                        ) : member.role === "owner" ? (
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            The owner cannot be removed; transfer ownership
                            first.
                          </span>
                        ) : null}
                        {canTransferOwnership(role) &&
                        member.role !== "owner" ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={pendingAction !== null}
                            onClick={() => {
                              setError(null);
                              setTransferConfirmation("");
                              setTransferTarget(member);
                            }}
                          >
                            {transferring
                              ? "Transferring…"
                              : "Transfer ownership"}
                          </Button>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {members.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No workspace members were returned.
        </p>
      ) : null}

      <Dialog
        open={roleChangeTarget !== null}
        onOpenChange={(open) => {
          if (!open && pendingAction === null) {
            setRoleChangeTarget(null);
            setRoleConfirmation("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm member role change?</DialogTitle>
            <DialogDescription>
              The backend will enforce the owner/admin hierarchy. No role is
              changed until you confirm the exact member email below.
            </DialogDescription>
          </DialogHeader>
          {roleChangeTarget !== null ? (
            <div className="space-y-3">
              <p className="text-sm">
                Change <strong>{roleChangeTarget.member.email}</strong> from{" "}
                {roleLabel(roleChangeTarget.member.role)} to{" "}
                {roleLabel(roleChangeTarget.nextRole)}?
              </p>
              <div className="space-y-2">
                <Label htmlFor="role-change-confirm">
                  Type the member email to confirm
                </Label>
                <Input
                  id="role-change-confirm"
                  value={roleConfirmation}
                  autoComplete="off"
                  onChange={(event) => setRoleConfirmation(event.target.value)}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pendingAction !== null}
              onClick={() => {
                setRoleChangeTarget(null);
                setRoleConfirmation("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                pendingAction !== null ||
                roleChangeTarget === null ||
                roleConfirmation !== roleChangeTarget.member.email
              }
              onClick={() => void changeRole()}
            >
              {pendingAction !== null ? "Changing…" : "Change role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && pendingAction === null) {
            setRemoveTarget(null);
            setRemoveConfirmation("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove workspace member?</DialogTitle>
            <DialogDescription>
              This removes the member from the workspace. The server still
              enforces role hierarchy and the single-owner invariant.
            </DialogDescription>
          </DialogHeader>
          {removeTarget !== null ? (
            <div className="space-y-3">
              <p className="text-sm">
                Confirm removal of <strong>{removeTarget.name}</strong> (
                {removeTarget.email}).
              </p>
              <div className="space-y-2">
                <Label htmlFor="remove-member-confirm">
                  Type the member email
                </Label>
                <Input
                  id="remove-member-confirm"
                  value={removeConfirmation}
                  autoComplete="off"
                  onChange={(event) =>
                    setRemoveConfirmation(event.target.value)
                  }
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pendingAction !== null}
              onClick={() => {
                setRemoveTarget(null);
                setRemoveConfirmation("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                pendingAction !== null ||
                removeTarget === null ||
                removeConfirmation !== removeTarget.email
              }
              onClick={() => void removeMember()}
            >
              {pendingAction !== null ? "Removing…" : "Remove member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={transferTarget !== null}
        onOpenChange={(open) => {
          if (!open && pendingAction === null) {
            setTransferTarget(null);
            setTransferConfirmation("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Transfer workspace ownership?</DialogTitle>
            <DialogDescription>
              Ownership transfer is irreversible from this screen. You will
              become an admin after the server completes the transaction.
            </DialogDescription>
          </DialogHeader>
          {transferTarget !== null ? (
            <div className="space-y-3">
              <p className="text-sm">
                Transfer ownership to <strong>{transferTarget.name}</strong> (
                {transferTarget.email})?
              </p>
              <div className="space-y-2">
                <Label htmlFor="transfer-owner-confirm">
                  Type the member email to confirm
                </Label>
                <Input
                  id="transfer-owner-confirm"
                  value={transferConfirmation}
                  autoComplete="off"
                  onChange={(event) =>
                    setTransferConfirmation(event.target.value)
                  }
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pendingAction !== null}
              onClick={() => {
                setTransferTarget(null);
                setTransferConfirmation("");
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                pendingAction !== null ||
                transferTarget === null ||
                transferConfirmation !== transferTarget.email
              }
              onClick={() => void transferOwnership()}
            >
              {pendingAction !== null ? "Transferring…" : "Transfer ownership"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Membership changes are audited by the backend. No role change or removal
        is applied optimistically in this UI.
      </p>
    </div>
  );

  function canManageMember(member: WorkspaceMember): boolean {
    return (
      canManage &&
      member.role !== "owner" &&
      (role === "owner" ||
        (role === "admin" &&
          (member.role === "member" || member.role === "viewer")))
    );
  }
}
