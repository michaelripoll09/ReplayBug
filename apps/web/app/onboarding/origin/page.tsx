"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { api } from "@/lib/api";
import { ApiError } from "@replaybug/api-client";
import { useInvalidateDomain } from "@/lib/queries";
import { toUiError } from "@/lib/errors";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { FieldError } from "@/components/forms/feedback";

const originSchema = z.object({
  origin: z.string().trim().min(1, "Origin is required").max(2000),
});

type OriginValues = z.infer<typeof originSchema>;

export const dynamic = "force-dynamic";

/**
 * Step 3: configure the first allowed origin (explicit consent only).
 * Suggests localhost dev origins but never adds without consent. Backend
 * parser errors are shown verbatim-safe. Skipping is allowed: origins can be
 * added later in project settings.
 */
export default function OriginStep(): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get("projectId");
  const { invalidateOrigins } = useInvalidateDomain();
  const [error, setError] = React.useState<string | null>(null);
  const form = useForm<OriginValues>({
    resolver: zodResolver(originSchema),
    defaultValues: { origin: "" },
  });
  const inputId = React.useId();

  async function add(values: OriginValues): Promise<void> {
    if (projectId === null) {
      return;
    }
    const pid: string = projectId;
    setError(null);
    try {
      const {
        data,
        error: apiError,
        response,
      } = await api.client.POST("/api/v1/projects/{projectId}/origins", {
        params: { path: { projectId: pid } },
        body: { origin: values.origin },
      });
      if (apiError !== undefined || data === undefined) {
        throw await api.unwrap({ data, error: apiError, response });
      }
      await invalidateOrigins(pid);
      router.push(`/onboarding/complete?projectId=${pid}`);
    } catch (e) {
      setError(
        e instanceof ApiError ? toUiError(e).message : "Could not add origin.",
      );
    }
  }

  function skip(): void {
    if (projectId === null) {
      router.push("/onboarding/workspace");
      return;
    }
    router.push(`/onboarding/complete?projectId=${projectId}`);
  }

  if (projectId === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Configure an origin</CardTitle>
          <CardDescription>Create a project first.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            onClick={() => router.push("/onboarding/workspace")}
          >
            Back to start
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Allow a browser origin</CardTitle>
        <CardDescription>
          Only browsers on this list may send telemetry. Add one now, or skip
          and do it later in settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="text-zinc-500">
            Dev suggestions (explicit consent only):
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => form.setValue("origin", "http://localhost:3000")}
          >
            <span className="font-mono">http://localhost:3000</span>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => form.setValue("origin", "http://localhost:5173")}
          >
            <span className="font-mono">http://localhost:5173</span>
          </Button>
        </div>
        <form
          onSubmit={(e) => void form.handleSubmit(add)(e)}
          noValidate
          className="space-y-3"
        >
          <div className="space-y-2">
            <Label htmlFor={inputId}>Origin</Label>
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
          {error !== null ? (
            <Alert variant="destructive" title="Could not add origin">
              {error}
            </Alert>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting
                ? "Adding…"
                : "Add origin and finish"}
            </Button>
            <Button type="button" variant="outline" onClick={skip}>
              Skip for now
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
