"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import { useInvalidateDomain } from "@/lib/queries";
import { canDeleteWorkspace, canLeaveWorkspace } from "@/lib/rbac";
import { toUiError } from "@/lib/errors";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useWorkspaceSettings } from "./workspace-settings-context";

function mutationMessage(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? toUiError(cause).message : fallback;
}

export function DangerZoneSettings(): React.JSX.Element {
  const router = useRouter();
  const { workspaceId, workspace, role } = useWorkspaceSettings();
  const { removeWorkspaceSensitive } = useInvalidateDomain();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [leaveOpen, setLeaveOpen] = React.useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = React.useState("");
  const [leaveConfirmation, setLeaveConfirmation] = React.useState("");
  const [pending, setPending] = React.useState<"delete" | "leave" | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const deleteId = React.useId();
  const leaveId = React.useId();

  async function deleteWorkspace(): Promise<void> {
    if (!canDeleteWorkspace(role) || deleteConfirmation !== workspace.slug) {
      return;
    }
    setError(null);
    setPending("delete");
    try {
      const {
        data,
        error: apiError,
        response,
      } = await api.client.DELETE("/api/v1/workspaces/{id}", {
        params: { path: { id: workspaceId } },
        body: { confirmation: workspace.slug },
      });
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      removeWorkspaceSensitive(workspaceId);
      router.push("/app");
      router.refresh();
    } catch (cause) {
      setError(mutationMessage(cause, "The workspace could not be deleted."));
      setPending(null);
    }
  }

  async function leaveWorkspace(): Promise<void> {
    if (
      !canLeaveWorkspace(role) ||
      role === "owner" ||
      leaveConfirmation !== workspace.slug
    ) {
      return;
    }
    setError(null);
    setPending("leave");
    try {
      const {
        data,
        error: apiError,
        response,
      } = await api.client.POST("/api/v1/workspaces/{workspaceId}/leave", {
        params: { path: { workspaceId } },
      });
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      removeWorkspaceSensitive(workspaceId);
      router.push("/app");
      router.refresh();
    } catch (cause) {
      setError(mutationMessage(cause, "You could not leave the workspace."));
      setPending(null);
    }
  }

  return (
    <div className="space-y-5">
      {error !== null ? (
        <Alert variant="destructive" title="Workspace action failed">
          {error}
        </Alert>
      ) : null}
      <section
        aria-labelledby="workspace-danger-heading"
        className="rounded-lg border border-red-200 p-4 dark:border-red-900"
      >
        <h2
          id="workspace-danger-heading"
          className="font-medium text-red-700 dark:text-red-300"
        >
          Delete workspace
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
          Deleting “{workspace.name}” permanently removes the workspace,
          memberships, invitations, projects, telemetry records, and associated
          artifacts through the backend cleanup transaction. This is
          irreversible; the server remains the final authority.
        </p>
        {canDeleteWorkspace(role) ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="mt-4"
            disabled={pending !== null}
            onClick={() => {
              setDeleteConfirmation("");
              setDeleteOpen(true);
            }}
          >
            Delete workspace…
          </Button>
        ) : (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            Only the workspace owner can delete it.
          </p>
        )}
      </section>

      <section
        aria-labelledby="workspace-leave-heading"
        className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
      >
        <h2 id="workspace-leave-heading" className="font-medium">
          Leave workspace
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
          Leaving removes your membership. It does not delete the workspace or
          its data. Confirm the current workspace slug before continuing.
        </p>
        {role === "owner" ? (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            The single workspace owner cannot leave. Transfer ownership first,
            then the new admin can leave if appropriate.
          </p>
        ) : canLeaveWorkspace(role) ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4"
            disabled={pending !== null}
            onClick={() => {
              setLeaveConfirmation("");
              setLeaveOpen(true);
            }}
          >
            Leave workspace…
          </Button>
        ) : (
          <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            Your role cannot leave this workspace.
          </p>
        )}
      </section>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (pending === null) {
            setDeleteOpen(open);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{workspace.name}”?</DialogTitle>
            <DialogDescription>
              This permanently deletes workspace data and artifacts. Type the
              exact, case-sensitive slug to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={deleteId}>Workspace slug</Label>
            <Input
              id={deleteId}
              value={deleteConfirmation}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setDeleteConfirmation(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending !== null}
              onClick={() => setDeleteOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                pending !== null || deleteConfirmation !== workspace.slug
              }
              onClick={() => void deleteWorkspace()}
            >
              {pending === "delete" ? "Deleting…" : "Delete workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={leaveOpen}
        onOpenChange={(open) => {
          if (pending === null) {
            setLeaveOpen(open);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave “{workspace.name}”?</DialogTitle>
            <DialogDescription>
              You will lose access to this workspace until you are invited
              again. Type the exact workspace slug to confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={leaveId}>Workspace slug</Label>
            <Input
              id={leaveId}
              value={leaveConfirmation}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setLeaveConfirmation(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending !== null}
              onClick={() => setLeaveOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={
                pending !== null || leaveConfirmation !== workspace.slug
              }
              onClick={() => void leaveWorkspace()}
            >
              {pending === "leave" ? "Leaving…" : "Leave workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
