"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useForm, type Resolver } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import { projectQuery, useInvalidateDomain } from "@/lib/queries";
import { canManageProject, type WorkspaceRole } from "@/lib/rbac";
import { toUiError, fieldErrorsFromApiError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { FieldError } from "@/components/forms/feedback";
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

const generalSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  description: z.string().trim().max(2000),
  timezone: z.string().trim().min(1, "Timezone is required").max(100),
  retentionDays: z.number().int().min(7).max(365),
});

type GeneralValues = z.infer<typeof generalSchema>;

/** Project general settings: GET/PATCH supported fields only. */
export function GeneralSettings({
  projectId,
  role,
}: {
  projectId: string;
  role: WorkspaceRole;
}): React.JSX.Element {
  const router = useRouter();
  const { invalidateProject } = useInvalidateDomain();
  const query = useQuery(projectQuery(projectId));
  const [status, setStatus] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = React.useState("");
  const [deleting, setDeleting] = React.useState(false);
  const editable = canManageProject(role);

  const form = useForm<GeneralValues>({
    resolver: zodResolver(generalSchema) as unknown as Resolver<GeneralValues>,
    defaultValues: {
      name: "",
      description: "",
      timezone: "UTC",
      retentionDays: 30,
    },
  });

  const loaded = query.data;

  const ids = {
    name: React.useId(),
    description: React.useId(),
    timezone: React.useId(),
    retention: React.useId(),
  };

  React.useEffect(() => {
    if (loaded !== undefined) {
      form.reset({
        name: loaded.name,
        description: loaded.description ?? "",
        timezone: loaded.timezone,
        retentionDays: loaded.retentionDays,
      });
    }
  }, [loaded?.id]);

  if (query.isPending) {
    return <RouteSkeleton lines={4} />;
  }
  if (query.isError || loaded === undefined) {
    return (
      <Alert variant="destructive" title="Could not load project">
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
  const project = loaded;

  async function onSubmit(values: GeneralValues): Promise<void> {
    setStatus(null);
    setFormError(null);
    try {
      const {
        data: updated,
        error,
        response,
      } = await api.client.PATCH("/api/v1/projects/{id}", {
        params: { path: { id: projectId } },
        body: {
          name: values.name,
          description:
            values.description.length > 0 ? values.description : null,
          timezone: values.timezone,
          retentionDays: values.retentionDays,
        },
      });
      if (error !== undefined || updated === undefined) {
        throw await api.unwrap({ data: updated, error, response });
      }
      await invalidateProject(projectId);
      setStatus("Saved.");
    } catch (error) {
      if (error instanceof ApiError) {
        const fields = fieldErrorsFromApiError(error);
        for (const [key, message] of Object.entries(fields)) {
          if (
            key === "name" ||
            key === "description" ||
            key === "timezone" ||
            key === "retentionDays"
          ) {
            form.setError(key, { message });
          }
        }
        setFormError(toUiError(error).message);
      } else {
        setFormError("Save failed. Please try again.");
      }
    }
  }

  async function onDelete(): Promise<void> {
    if (deleteConfirmation !== project.slug) {
      return;
    }
    setDeleting(true);
    try {
      const {
        data: result,
        error,
        response,
      } = await api.client.DELETE("/api/v1/projects/{id}", {
        params: { path: { id: projectId } },
        body: { confirmation: project.slug },
      });
      if (error !== undefined || result === undefined) {
        throw await api.unwrap({ data: result, error, response });
      }
      await invalidateProject(projectId);
      router.push(`/app/workspaces/${project.workspaceId}`);
      router.refresh();
    } catch (error) {
      setFormError(
        error instanceof ApiError ? toUiError(error).message : "Delete failed.",
      );
      setDeleting(false);
      setDeleteConfirmation("");
      setDeleteOpen(false);
    }
  }

  return (
    <div className="space-y-6">
      {!editable ? (
        <Alert title="Read-only">
          Your role ({role}) can view project settings but cannot change them.
        </Alert>
      ) : null}
      <form
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        noValidate
        className="space-y-4"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={ids.name}>Name</Label>
            <Input
              id={ids.name}
              disabled={!editable}
              {...form.register("name")}
            />
            <FieldError
              id={`${ids.name}-error`}
              message={form.formState.errors.name?.message}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={ids.timezone}>Timezone</Label>
            <Input
              id={ids.timezone}
              disabled={!editable}
              placeholder="UTC"
              {...form.register("timezone")}
            />
            <FieldError
              id={`${ids.timezone}-error`}
              message={form.formState.errors.timezone?.message}
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.description}>Description</Label>
          <Input
            id={ids.description}
            disabled={!editable}
            {...form.register("description")}
          />
          <FieldError
            id={`${ids.description}-error`}
            message={form.formState.errors.description?.message}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.retention}>Retention (days, 7–365)</Label>
          <Input
            id={ids.retention}
            type="number"
            min={7}
            max={365}
            disabled={!editable}
            aria-describedby={`${ids.retention}-help`}
            {...form.register("retentionDays", { valueAsNumber: true })}
          />
          <p
            id={`${ids.retention}-help`}
            className="text-xs text-zinc-500 dark:text-zinc-400"
          >
            Raw telemetry and events are retained for this configured period.
            Issue aggregates, comments/activity, reproductions, affected-session
            lifetime counters, and audit history may remain longer according to
            policy.
          </p>
          <FieldError
            id={`${ids.retention}-error`}
            message={form.formState.errors.retentionDays?.message}
          />
        </div>
        {formError !== null ? (
          <Alert variant="destructive" title="Could not save">
            {formError}
          </Alert>
        ) : null}
        {status !== null ? (
          <Alert title="Saved">
            <span role="status">{status}</span>
          </Alert>
        ) : null}
        {editable ? (
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Saving…" : "Save changes"}
          </Button>
        ) : null}
      </form>

      {editable ? (
        <section
          aria-labelledby="danger-zone"
          className="rounded-lg border border-red-200 p-4 dark:border-red-900"
        >
          <h2
            id="danger-zone"
            className="font-medium text-red-700 dark:text-red-300"
          >
            Danger zone
          </h2>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            Deleting a project is irreversible. It removes project data and
            schedules durable, asynchronous cleanup of associated artifacts;
            cleanup may continue after this screen closes.
          </p>
          <Dialog
            open={deleteOpen}
            onOpenChange={(open) => {
              setDeleteOpen(open);
              if (!open) {
                setDeleteConfirmation("");
              }
            }}
          >
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="mt-3"
              >
                Delete project…
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete “{project.name}”?</DialogTitle>
                <DialogDescription>
                  Type the exact, case-sensitive project slug to confirm.
                  Deletion is irreversible; associated artifact cleanup is
                  durable and asynchronous.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="delete-confirm">Project slug</Label>
                <Input
                  id="delete-confirm"
                  value={deleteConfirmation}
                  onChange={(e) => setDeleteConfirmation(e.target.value)}
                  placeholder={project.slug}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDeleteOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={deleting || deleteConfirmation !== project.slug}
                  onClick={() => void onDelete()}
                >
                  {deleting ? "Deleting…" : "Delete project"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </section>
      ) : null}
    </div>
  );
}
