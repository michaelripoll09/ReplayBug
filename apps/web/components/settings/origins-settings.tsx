"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import { originsQuery, useInvalidateDomain } from "@/lib/queries";
import { canManageOrigins, type WorkspaceRole } from "@/lib/rbac";
import { toUiError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { FieldError } from "@/components/forms/feedback";

const originSchema = z.object({
  origin: z.string().trim().min(1, "Origin is required").max(2000),
});

type OriginValues = z.infer<typeof originSchema>;

/** Allowed origins: origin/enabled; add/enable-disable/edit/delete. */
export function OriginsSettings({
  projectId,
  role,
}: {
  projectId: string;
  role: WorkspaceRole;
}): React.JSX.Element {
  const { invalidateOrigins } = useInvalidateDomain();
  const { data, isPending, isError, refetch } = useQuery(
    originsQuery(projectId),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const editable = canManageOrigins(role);
  const form = useForm<OriginValues>({
    resolver: zodResolver(originSchema),
    defaultValues: { origin: "" },
  });
  const inputId = React.useId();

  if (isPending) {
    return <RouteSkeleton lines={3} />;
  }
  if (isError || data === undefined) {
    return (
      <Alert variant="destructive" title="Could not load origins">
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

  async function add(values: OriginValues): Promise<void> {
    setError(null);
    setStatus(null);
    try {
      const {
        data: created,
        error: apiError,
        response,
      } = await api.client.POST("/api/v1/projects/{projectId}/origins", {
        params: { path: { projectId } },
        body: { origin: values.origin },
      });
      if (apiError !== undefined || created === undefined) {
        throw await api.unwrap({ data: created, error: apiError, response });
      }
      await invalidateOrigins(projectId);
      form.reset();
      setStatus(`Origin “${created.origin}” added.`);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `Could not add origin: ${toUiError(e).message}`
          : "Could not add origin.",
      );
    }
  }

  async function toggle(id: string, isEnabled: boolean): Promise<void> {
    setError(null);
    try {
      const {
        data: updated,
        error: apiError,
        response,
      } = await api.client.PATCH("/api/v1/origins/{id}", {
        params: { path: { id } },
        body: { isEnabled: !isEnabled },
      });
      if (apiError !== undefined || updated === undefined) {
        throw await api.unwrap({ data: updated, error: apiError, response });
      }
      await invalidateOrigins(projectId);
      setStatus(
        `Origin “${updated.origin}” ${updated.isEnabled ? "enabled" : "disabled"}.`,
      );
    } catch (e) {
      setError(e instanceof ApiError ? toUiError(e).message : "Update failed.");
    }
  }

  async function remove(id: string): Promise<void> {
    setError(null);
    try {
      const {
        data: result,
        error: apiError,
        response,
      } = await api.client.DELETE("/api/v1/origins/{id}", {
        params: { path: { id } },
      });
      if (apiError !== undefined || result === undefined) {
        throw await api.unwrap({ data: result, error: apiError, response });
      }
      await invalidateOrigins(projectId);
      setStatus("Origin deleted.");
    } catch (e) {
      setError(e instanceof ApiError ? toUiError(e).message : "Delete failed.");
    }
  }

  return (
    <div className="space-y-4">
      {!editable ? (
        <Alert title="Read-only">
          Your role ({role}) can view origins but cannot change them.
        </Alert>
      ) : null}
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        Only exact origins (scheme + host + port, no path) are allowed.
        Examples:{" "}
        <code className="font-mono text-xs">https://app.example.com</code>,{" "}
        <code className="font-mono text-xs">http://localhost:5173</code>.
        Wildcards and paths are rejected.
      </p>
      {error !== null ? (
        <Alert variant="destructive" title="Origins">
          {error}
        </Alert>
      ) : null}
      {status !== null ? (
        <Alert title="Origins">
          <span role="status">{status}</span>
        </Alert>
      ) : null}
      {data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No origins yet. Browser telemetry is rejected until at least one
          origin is added — with explicit consent only.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {data.map((o) => (
            <li key={o.id} className="flex items-center gap-3 px-4 py-3">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">
                {o.origin}
              </code>
              {o.isEnabled ? (
                <Badge>Enabled</Badge>
              ) : (
                <Badge variant="outline">Disabled</Badge>
              )}
              {editable ? (
                <span className="flex gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void toggle(o.id, o.isEnabled)}
                  >
                    {o.isEnabled ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(o.id)}
                  >
                    Delete
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editable ? (
        <form
          onSubmit={(e) => void form.handleSubmit(add)(e)}
          noValidate
          className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <div className="space-y-2">
            <Label htmlFor={inputId}>Add origin</Label>
            <Input
              id={inputId}
              placeholder="https://app.example.com"
              inputMode="url"
              autoComplete="url"
              {...form.register("origin")}
            />
            <FieldError
              id={`${inputId}-error`}
              message={form.formState.errors.origin?.message}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting ? "Adding…" : "Add origin"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
