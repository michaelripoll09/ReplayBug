"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type WorkspaceAuditAction,
  type WorkspaceAuditEvent,
  useInvalidateDomain,
  workspaceAuditQuery,
} from "@/lib/queries";
import { canManageAudit } from "@/lib/rbac";
import { formatDateTime as formatDateTimeValue } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { useWorkspaceSettings } from "./workspace-settings-context";

const auditActions = [
  "workspace.created",
  "workspace.updated",
  "workspace.ownership_transferred",
  "workspace.deletion_requested",
  "workspace.deletion_completed",
  "project.created",
  "project.updated",
  "project.deleted",
  "project.retention_changed",
  "project.deletion_requested",
  "project.deletion_completed",
  "workspace_invitation.created",
  "workspace_invitation.revoked",
  "workspace_invitation.accepted",
  "workspace_member.role_changed",
  "workspace_member.removed",
  "project_origin.created",
  "project_origin.updated",
  "project_origin.deleted",
  "project_key.rotated",
] as const satisfies readonly WorkspaceAuditAction[];

const auditActionLabels: Record<WorkspaceAuditAction, string> = {
  "workspace.created": "Workspace created",
  "workspace.updated": "Workspace updated",
  "workspace.ownership_transferred": "Ownership transferred",
  "workspace.deletion_requested": "Workspace deletion requested",
  "workspace.deletion_completed": "Workspace deleted",
  "project.created": "Project created",
  "project.updated": "Project updated",
  "project.deleted": "Project deleted",
  "project.retention_changed": "Project retention changed",
  "project.deletion_requested": "Project deletion requested",
  "project.deletion_completed": "Project deleted",
  "workspace_invitation.created": "Invitation created",
  "workspace_invitation.revoked": "Invitation revoked",
  "workspace_invitation.accepted": "Invitation accepted",
  "workspace_member.role_changed": "Member role changed",
  "workspace_member.removed": "Member removed",
  "project_origin.created": "Project origin created",
  "project_origin.updated": "Project origin updated",
  "project_origin.deleted": "Project origin deleted",
  "project_key.rotated": "Project key rotated",
};

function isWorkspaceAuditAction(value: string): value is WorkspaceAuditAction {
  return (auditActions as readonly string[]).includes(value);
}

function metadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 && value.length <= 320
    ? value
    : null;
}

/** Summarize only allowlisted scalar metadata; never render arbitrary JSON. */
export function summarizeAuditEvent(event: WorkspaceAuditEvent): string {
  switch (event.action) {
    case "workspace_invitation.created":
    case "workspace_invitation.revoked": {
      const email = metadataString(event.metadata, "email");
      const role = metadataString(event.metadata, "role");
      if (email !== null && role !== null) {
        return `${email} · ${role}`;
      }
      return "Invitation metadata is not available.";
    }
    case "workspace_member.role_changed": {
      const previousRole = metadataString(event.metadata, "previousRole");
      const nextRole = metadataString(event.metadata, "role");
      if (previousRole !== null && nextRole !== null) {
        return `Role changed from ${previousRole} to ${nextRole}.`;
      }
      return "Member role changed.";
    }
    case "workspace_member.removed": {
      const reason = metadataString(event.metadata, "reason");
      return reason === "left"
        ? "Member left the workspace."
        : "Member removed.";
    }
    case "workspace.ownership_transferred":
      return "Workspace ownership changed.";
    case "workspace.updated":
      return "Workspace settings changed.";
    default:
      return auditActionLabels[event.action];
  }
}

export function AuditLogSettings(): React.JSX.Element {
  const { workspaceId, role } = useWorkspaceSettings();
  const canView = canManageAudit(role);
  const [action, setAction] = React.useState<WorkspaceAuditAction | "">("");
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [cursorHistory, setCursorHistory] = React.useState<string[]>([]);
  const params = React.useMemo(
    () => ({
      limit: 50,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(action !== "" ? { action } : {}),
    }),
    [action, cursor],
  );
  const auditQuery = useQuery({
    ...workspaceAuditQuery(workspaceId, params),
    enabled: canView,
  });
  const { invalidateWorkspaceAudit } = useInvalidateDomain();

  function changeAction(value: string): void {
    if (value !== "" && !isWorkspaceAuditAction(value)) {
      return;
    }
    setAction(value);
    setCursor(undefined);
    setCursorHistory([]);
  }

  function nextPage(nextCursor: string): void {
    setCursorHistory((history) => [...history, cursor ?? ""]);
    setCursor(nextCursor);
  }

  function previousPage(): void {
    const previous = cursorHistory[cursorHistory.length - 1];
    if (previous === undefined) {
      return;
    }
    setCursorHistory((history) => history.slice(0, -1));
    setCursor(previous.length > 0 ? previous : undefined);
  }

  if (!canView) {
    return (
      <Alert title="Audit log is restricted">
        Your role ({role}) can view workspace settings but cannot view the
        workspace audit log. Owners and admins have audit access.
      </Alert>
    );
  }

  if (auditQuery.isPending) {
    return <RouteSkeleton lines={5} />;
  }
  if (auditQuery.isError || auditQuery.data === undefined) {
    return (
      <Alert variant="destructive" title="Could not load audit log">
        Please try again.
        <span className="mt-2 block">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void auditQuery.refetch()}
          >
            Retry
          </Button>
        </span>
      </Alert>
    );
  }

  const page = auditQuery.data;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Newest events appear first. Results are bounded and use
            server-issued cursors; action filters are allowlisted by the API
            contract.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <span>Action</span>
          <select
            aria-label="Filter audit action"
            className="h-9 rounded-md border border-zinc-200 bg-white px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
            value={action}
            onChange={(event) => changeAction(event.target.value)}
          >
            <option value="">All actions</option>
            {auditActions.map((candidate) => (
              <option key={candidate} value={candidate}>
                {auditActionLabels[candidate]}
              </option>
            ))}
          </select>
        </label>
      </div>
      {page.items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
          <h2 className="font-medium">No audit events</h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            {action === ""
              ? "Workspace activity will appear here after a governance or project event."
              : "No events match this action filter."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  When
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Action
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Actor
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Summary
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((event) => (
                <tr
                  key={event.id}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-500">
                    {formatDateTimeValue(event.createdAt)}
                  </td>
                  <td className="px-4 py-3">
                    {auditActionLabels[event.action]}
                  </td>
                  <td className="px-4 py-3">
                    {event.actor === null ? (
                      <span className="text-zinc-500">System</span>
                    ) : (
                      <span>
                        {event.actor.name} · {event.actor.email}
                      </span>
                    )}
                  </td>
                  <td className="max-w-md px-4 py-3 text-zinc-600 dark:text-zinc-300">
                    {summarizeAuditEvent(event)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={cursorHistory.length === 0 || auditQuery.isFetching}
          onClick={previousPage}
        >
          Previous page
        </Button>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          Showing up to {params.limit} events
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={page.nextCursor === undefined || auditQuery.isFetching}
          onClick={() => {
            if (page.nextCursor !== undefined) {
              nextPage(page.nextCursor);
            }
          }}
        >
          Next page
        </Button>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => void invalidateWorkspaceAudit(workspaceId)}
      >
        Refresh audit log
      </Button>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Metadata is summarized from safe allowlisted fields. Arbitrary metadata
        objects are never rendered.
      </p>
    </div>
  );
}
