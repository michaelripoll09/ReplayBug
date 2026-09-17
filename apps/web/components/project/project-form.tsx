"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import { useInvalidateDomain } from "@/lib/queries";
import { toUiError, fieldErrorsFromApiError } from "@/lib/errors";
import { OneTimeSecret } from "@/components/secrets/one-time-secret";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { FieldError } from "@/components/forms/feedback";

const projectSchema = z.object({
  name: z.string().trim().min(1, "Project name is required").max(100),
  description: z.string().trim().max(2000).optional(),
});

type ProjectValues = z.infer<typeof projectSchema>;

export interface CreatedProject {
  id: string;
  name: string;
  prefix: string;
  projectId: string;
}

/**
 * Project creation with ONE-TIME key handling.
 * The plaintext key lives in component memory only and is lifted to the
 * parent via `onCreated` — never persisted, logged, or cached.
 */
export function ProjectForm({
  workspaceId,
  onCreated,
  submitLabel = "Create project",
}: {
  workspaceId: string;
  onCreated?: (created: CreatedProject, secret: string) => void;
  submitLabel?: string;
}): React.JSX.Element {
  const router = useRouter();
  const { invalidateProjects } = useInvalidateDomain();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [oneTimeKey, setOneTimeKey] = React.useState<string | null>(null);
  const [createdName, setCreatedName] = React.useState<string | null>(null);
  const form = useForm<ProjectValues>({
    resolver: zodResolver(projectSchema),
    defaultValues: { name: "", description: "" },
  });

  async function onSubmit(values: ProjectValues): Promise<void> {
    setFormError(null);
    try {
      const { data, error, response } = await api.client.POST(
        "/api/v1/workspaces/{workspaceId}/projects",
        {
          params: { path: { workspaceId } },
          body: {
            name: values.name,
            ...(values.description !== undefined &&
            values.description.length > 0
              ? { description: values.description }
              : {}),
          },
        },
      );
      if (error !== undefined || data === undefined) {
        throw await api.unwrap({ data: data, error, response });
      }
      await invalidateProjects(workspaceId);
      const secret = data.bootstrap.key;
      setOneTimeKey(secret);
      setCreatedName(data.project.name);
      onCreated?.(
        {
          id: data.project.id,
          name: data.project.name,
          prefix: data.bootstrap.prefix,
          projectId: data.project.id,
        },
        secret,
      );
      if (onCreated === undefined) {
        // Standalone usage outside onboarding: stay on page and show the key.
      }
      void router;
    } catch (error) {
      if (error instanceof ApiError) {
        const fields = fieldErrorsFromApiError(error);
        if (fields["name"] !== undefined) {
          form.setError("name", { message: fields["name"] });
        }
        if (fields["description"] !== undefined) {
          form.setError("description", { message: fields["description"] });
        }
        setFormError(toUiError(error).message);
      } else {
        setFormError("Project creation failed. Please try again.");
      }
    }
  }

  const submitting = form.formState.isSubmitting;
  const ids = { name: React.useId(), description: React.useId() };

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        noValidate
        className="space-y-4"
      >
        <div className="space-y-2">
          <Label htmlFor={ids.name}>Project name</Label>
          <Input
            id={ids.name}
            placeholder="storefront-web"
            aria-invalid={form.formState.errors.name !== undefined}
            {...form.register("name")}
          />
          <FieldError
            id={`${ids.name}-error`}
            message={form.formState.errors.name?.message}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={ids.description}>Description (optional)</Label>
          <Input id={ids.description} {...form.register("description")} />
          <FieldError
            id={`${ids.description}-error`}
            message={form.formState.errors.description?.message}
          />
        </div>
        {formError !== null ? (
          <Alert variant="destructive" title="Could not create project">
            {formError}
          </Alert>
        ) : null}
        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Creating…" : submitLabel}
        </Button>
      </form>
      {oneTimeKey !== null && onCreated === undefined ? (
        <OneTimeSecret
          secret={oneTimeKey}
          label={`Public ingest key for ${createdName ?? "project"}`}
          hint="Copy it now. It will never be shown again. Telemetry integration is not enabled in this build yet."
        />
      ) : null}
    </div>
  );
}
