"use client";

import * as React from "react";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import { useInvalidateDomain, workspaceGovernanceClient } from "@/lib/queries";
import { canManageWorkspace } from "@/lib/rbac";
import { toUiError } from "@/lib/errors";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWorkspaceSettings } from "./workspace-settings-context";

const workspaceSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isValidWorkspaceSlug(value: string): boolean {
  return (
    value.length >= 1 && value.length <= 100 && workspaceSlugPattern.test(value)
  );
}

export function validateWorkspaceName(value: string): string | null {
  const name = value.trim();
  if (name.length === 0) {
    return "Workspace name is required.";
  }
  if (name.length > 100) {
    return "Workspace name must be 100 characters or fewer.";
  }
  return null;
}

export function validateWorkspaceSlug(value: string): string | null {
  if (!isValidWorkspaceSlug(value)) {
    return "Use lowercase letters, numbers, and single hyphens only.";
  }
  return null;
}

export function GeneralSettings(): React.JSX.Element {
  const { workspaceId, workspace, role } = useWorkspaceSettings();
  const {
    invalidateWorkspace,
    invalidateWorkspaces,
    invalidateWorkspaceAudit,
  } = useInvalidateDomain();
  const editable = canManageWorkspace(role);
  const [name, setName] = React.useState(workspace.name);
  const [slug, setSlug] = React.useState(workspace.slug);
  const [nameError, setNameError] = React.useState<string | null>(null);
  const [slugError, setSlugError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const nameId = React.useId();
  const slugId = React.useId();

  React.useEffect(() => {
    setName(workspace.name);
    setSlug(workspace.slug);
  }, [workspace.id]);

  async function save(): Promise<void> {
    const normalizedName = name.trim();
    const normalizedSlug = slug.trim().toLowerCase();
    const nextNameError = validateWorkspaceName(normalizedName);
    const nextSlugError = validateWorkspaceSlug(normalizedSlug);
    setNameError(nextNameError);
    setSlugError(nextSlugError);
    setError(null);
    setStatus(null);
    if (nextNameError !== null || nextSlugError !== null) {
      return;
    }

    setSaving(true);
    try {
      const {
        data,
        error: apiError,
        response,
      } = await workspaceGovernanceClient.PATCH("/api/v1/workspaces/{id}", {
        params: { path: { id: workspaceId } },
        body: { name: normalizedName, slug: normalizedSlug },
      });
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      setName(data.name);
      setSlug(data.slug);
      await Promise.all([
        invalidateWorkspace(workspaceId),
        invalidateWorkspaces(),
        invalidateWorkspaceAudit(workspaceId),
      ]);
      setStatus("Workspace settings saved.");
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? toUiError(cause).message
          : "Workspace settings could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (!editable) {
    return (
      <div className="space-y-4">
        <Alert title="Read-only workspace settings">
          Your role ({role}) can view the workspace name and slug, but only the
          owner can edit them.
        </Alert>
        <dl className="grid gap-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800 md:grid-cols-2">
          <div>
            <dt className="text-sm font-medium">Name</dt>
            <dd className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              {workspace.name}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium">Slug</dt>
            <dd className="mt-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">
              {workspace.slug}
            </dd>
          </div>
        </dl>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Change the workspace display name or URL-safe slug. Slug changes are
        case-insensitive and are validated before the server receives them.
      </p>
      {error !== null ? (
        <Alert variant="destructive" title="Could not save workspace">
          {error}
        </Alert>
      ) : null}
      {status !== null ? (
        <Alert title="Workspace updated">
          <span role="status">{status}</span>
        </Alert>
      ) : null}
      <form
        className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        noValidate
      >
        <div className="space-y-2">
          <Label htmlFor={nameId}>Workspace name</Label>
          <Input
            id={nameId}
            value={name}
            maxLength={100}
            aria-invalid={nameError !== null}
            aria-describedby={
              nameError !== null ? `${nameId}-error` : undefined
            }
            onChange={(event) => setName(event.target.value)}
          />
          {nameError !== null ? (
            <p
              id={`${nameId}-error`}
              role="alert"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {nameError}
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <Label htmlFor={slugId}>Workspace slug</Label>
          <Input
            id={slugId}
            value={slug}
            maxLength={100}
            spellCheck={false}
            autoCapitalize="none"
            aria-invalid={slugError !== null}
            aria-describedby={
              slugError !== null ? `${slugId}-error` : undefined
            }
            onChange={(event) => setSlug(event.target.value.toLowerCase())}
          />
          {slugError !== null ? (
            <p
              id={`${slugId}-error`}
              role="alert"
              className="text-sm text-red-600 dark:text-red-400"
            >
              {slugError}
            </p>
          ) : null}
        </div>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </form>
    </div>
  );
}
