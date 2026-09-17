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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { FieldError } from "@/components/forms/feedback";

const workspaceSchema = z.object({
  name: z.string().trim().min(1, "Workspace name is required").max(100),
});

type WorkspaceValues = z.infer<typeof workspaceSchema>;

/** Reusable workspace creation form. Owner role comes from the backend. */
export function WorkspaceForm({
  onCreated,
  submitLabel = "Create workspace",
}: {
  onCreated?: (id: string) => void;
  submitLabel?: string;
}): React.JSX.Element {
  const router = useRouter();
  const { invalidateWorkspaces } = useInvalidateDomain();
  const [formError, setFormError] = React.useState<string | null>(null);
  const [requestId, setRequestId] = React.useState<string | undefined>(
    undefined,
  );
  const form = useForm<WorkspaceValues>({
    resolver: zodResolver(workspaceSchema),
    defaultValues: { name: "" },
  });
  const inputId = React.useId();
  const errorId = `${inputId}-error`;

  async function onSubmit(values: WorkspaceValues): Promise<void> {
    setFormError(null);
    setRequestId(undefined);
    try {
      const { data, error, response } = await api.client.POST(
        "/api/v1/workspaces",
        {
          body: { name: values.name },
        },
      );
      if (error !== undefined || data === undefined) {
        throw await api.unwrap({ data: data, error, response });
      }
      await invalidateWorkspaces();
      if (onCreated !== undefined) {
        onCreated(data.id);
      } else {
        router.push(`/app/workspaces/${data.id}`);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        const fields = fieldErrorsFromApiError(error);
        if (fields["name"] !== undefined) {
          form.setError("name", { message: fields["name"] });
        }
        const ui = toUiError(error);
        setFormError(ui.message);
        setRequestId(ui.requestId);
      } else {
        setFormError("Workspace creation failed. Please try again.");
      }
    }
  }

  const submitting = form.formState.isSubmitting;
  return (
    <form
      onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
      noValidate
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor={inputId}>Workspace name</Label>
        <Input
          id={inputId}
          autoComplete="organization"
          placeholder="Acme"
          aria-invalid={form.formState.errors.name !== undefined}
          aria-describedby={
            form.formState.errors.name !== undefined ? errorId : undefined
          }
          {...form.register("name")}
        />
        <FieldError
          id={errorId}
          message={form.formState.errors.name?.message}
        />
      </div>
      {formError !== null ? (
        <Alert variant="destructive" title="Could not create workspace">
          {formError}
          {requestId !== undefined ? (
            <span className="mt-1 block font-mono text-xs">
              ID: {requestId}
            </span>
          ) : null}
        </Alert>
      ) : null}
      <Button type="submit" className="w-full" disabled={submitting}>
        {submitting ? "Creating…" : submitLabel}
      </Button>
    </form>
  );
}
