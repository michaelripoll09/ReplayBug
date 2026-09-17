"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import { environmentsQuery, useInvalidateDomain } from "@/lib/queries";
import { canManageEnvironments, type WorkspaceRole } from "@/lib/rbac";
import { toUiError } from "@/lib/errors";
import { formatDateTime } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/forms/feedback";

const envSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  baseUrl: z.string().trim().max(2000).optional(),
  isDefault: z.boolean().optional(),
});

type EnvValues = z.infer<typeof envSchema>;

/** Environments table: name/baseUrl/default/dates; single-default + never-zero honored. */
export function EnvironmentsSettings({
  projectId,
  role,
}: {
  projectId: string;
  role: WorkspaceRole;
}): React.JSX.Element {
  const { invalidateEnvironments } = useInvalidateDomain();
  const query = useQuery(environmentsQuery(projectId));
  const [error, setError] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const editable = canManageEnvironments(role);

  const form = useForm<EnvValues>({
    resolver: zodResolver(envSchema),
    defaultValues: { name: "", baseUrl: "", isDefault: false },
  });
  const nameId = React.useId();

  if (query.isPending) {
    return <RouteSkeleton lines={3} />;
  }
  if (query.isError || query.data === undefined) {
    return (
      <Alert variant="destructive" title="Could not load environments">
        Please try again.
        <span className="mt-2 block">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </span>
      </Alert>
    );
  }
  const data = query.data;

  async function create(values: EnvValues): Promise<void> {
    setError(null);
    setStatus(null);
    try {
      const {
        data: created,
        error: apiError,
        response,
      } = await api.client.POST("/api/v1/projects/{projectId}/environments", {
        params: { path: { projectId } },
        body: {
          name: values.name,
          ...(values.baseUrl !== undefined && values.baseUrl.length > 0
            ? { baseUrl: values.baseUrl }
            : {}),
          ...(values.isDefault !== undefined
            ? { isDefault: values.isDefault }
            : {}),
        },
      });
      if (apiError !== undefined || created === undefined) {
        throw await api.unwrap({ data: created, error: apiError, response });
      }
      await invalidateEnvironments(projectId);
      form.reset({ name: "", baseUrl: "", isDefault: false });
      setStatus(`Environment “${created.name}” created.`);
    } catch (e) {
      setError(
        e instanceof ApiError ? toUiError(e).message : "Creation failed.",
      );
    }
  }

  async function setDefault(id: string): Promise<void> {
    setError(null);
    try {
      const {
        data: updated,
        error: apiError,
        response,
      } = await api.client.PATCH("/api/v1/environments/{id}", {
        params: { path: { id } },
        body: { isDefault: true },
      });
      if (apiError !== undefined || updated === undefined) {
        throw await api.unwrap({ data: updated, error: apiError, response });
      }
      await invalidateEnvironments(projectId);
      setStatus(`Default moved to “${updated.name}”.`);
    } catch (e) {
      setError(e instanceof ApiError ? toUiError(e).message : "Update failed.");
    }
  }

  async function remove(id: string): Promise<void> {
    setError(null);
    const current = data;
    if (current.length <= 1) {
      setError("The last environment cannot be deleted.");
      return;
    }
    try {
      const {
        data: result,
        error: apiError,
        response,
      } = await api.client.DELETE("/api/v1/environments/{id}", {
        params: { path: { id } },
      });
      if (apiError !== undefined || result === undefined) {
        throw await api.unwrap({ data: result, error: apiError, response });
      }
      await invalidateEnvironments(projectId);
      setStatus("Environment deleted. Default was promoted deterministically.");
    } catch (e) {
      setError(e instanceof ApiError ? toUiError(e).message : "Delete failed.");
    }
  }

  async function rename(
    id: string,
    name: string,
    baseUrl: string | null,
  ): Promise<void> {
    setError(null);
    try {
      const {
        data: updated,
        error: apiError,
        response,
      } = await api.client.PATCH("/api/v1/environments/{id}", {
        params: { path: { id } },
        body: {
          name,
          baseUrl,
        },
      });
      if (apiError !== undefined || updated === undefined) {
        throw await api.unwrap({ data: updated, error: apiError, response });
      }
      await invalidateEnvironments(projectId);
      setEditingId(null);
      setStatus(`Environment “${updated.name}” updated.`);
    } catch (e) {
      setError(e instanceof ApiError ? toUiError(e).message : "Update failed.");
    }
  }

  return (
    <div className="space-y-4">
      {!editable ? (
        <Alert title="Read-only">
          Your role ({role}) can view environments but cannot change them.
        </Alert>
      ) : null}
      {error !== null ? (
        <Alert variant="destructive" title="Environments">
          {error}
        </Alert>
      ) : null}
      {status !== null ? (
        <Alert title="Environments">
          <span role="status">{status}</span>
        </Alert>
      ) : null}
      {data.length === 0 ? (
        <EmptyState
          title="No environments"
          message="At least one environment is required; create one below."
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">
                  Name
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Base URL
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Default
                </th>
                <th scope="col" className="px-4 py-2 font-medium">
                  Updated
                </th>
                {editable ? (
                  <th scope="col" className="px-4 py-2 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {data.map((env) => (
                <tr
                  key={env.id}
                  className="border-t border-zinc-200 dark:border-zinc-800"
                >
                  <td className="px-4 py-2 font-mono">
                    {editingId === env.id && editable ? (
                      <EditRow
                        initialName={env.name}
                        initialBaseUrl={env.baseUrl ?? ""}
                        onCancel={() => setEditingId(null)}
                        onSave={(name, baseUrl) =>
                          void rename(
                            env.id,
                            name,
                            baseUrl.length > 0 ? baseUrl : null,
                          )
                        }
                      />
                    ) : (
                      env.name
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {env.baseUrl ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    {env.isDefault ? (
                      <Badge>Default</Badge>
                    ) : (
                      <span className="text-zinc-500">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-zinc-500">
                    {formatDateTime(env.updatedAt)}
                  </td>
                  {editable ? (
                    <td className="px-4 py-2">
                      <div className="flex gap-2">
                        {editingId === env.id ? null : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingId(env.id)}
                          >
                            Edit
                          </Button>
                        )}
                        {!env.isDefault ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => void setDefault(env.id)}
                          >
                            Make default
                          </Button>
                        ) : null}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={data.length <= 1}
                          title={
                            data.length <= 1
                              ? "The last environment cannot be deleted"
                              : "Delete environment"
                          }
                          onClick={() => void remove(env.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editable ? (
        <form
          onSubmit={(e) => void form.handleSubmit(create)(e)}
          noValidate
          className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
        >
          <h2 className="font-medium">Add environment</h2>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor={`${nameId}-name`}>Name</Label>
              <Input
                id={`${nameId}-name`}
                placeholder="staging"
                {...form.register("name")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${nameId}-url`}>Base URL (optional)</Label>
              <Input
                id={`${nameId}-url`}
                placeholder="https://staging.example.com"
                inputMode="url"
                {...form.register("baseUrl")}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" {...form.register("isDefault")} />
            Make default
          </label>
          <Button
            type="submit"
            size="sm"
            disabled={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting ? "Creating…" : "Create environment"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function EditRow({
  initialName,
  initialBaseUrl,
  onCancel,
  onSave,
}: {
  initialName: string;
  initialBaseUrl: string;
  onCancel: () => void;
  onSave: (name: string, baseUrl: string) => void;
}): React.JSX.Element {
  const [name, setName] = React.useState(initialName);
  const [baseUrl, setBaseUrl] = React.useState(initialBaseUrl);
  return (
    <span className="flex items-center gap-2">
      <input
        aria-label="Environment name"
        className="h-8 rounded border border-zinc-200 px-2 text-sm dark:border-zinc-800 dark:bg-zinc-950"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        aria-label="Environment base URL"
        className="h-8 rounded border border-zinc-200 px-2 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-950"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <Button
        type="button"
        size="sm"
        onClick={() => onSave(name.trim(), baseUrl.trim())}
        disabled={name.trim().length === 0}
      >
        Save
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </span>
  );
}
