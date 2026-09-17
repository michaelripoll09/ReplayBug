"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { projectQuery, environmentsQuery, originsQuery } from "@/lib/queries";
import { useOnboarding } from "@/components/onboarding/wizard-context";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { RouteSkeleton } from "@/components/ui/skeleton";
import { CheckCircle2 } from "lucide-react";

/** Step 4: summary (workspace/project/prod env/origin/key-copy state) + Go to project. */
export default function CompleteStep(): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const projectId = params.get("projectId");
  const { keyAcknowledged, secret } = useOnboarding();

  const project = useQuery({
    ...projectQuery(projectId ?? "missing"),
    enabled: projectId !== null,
  });
  const envs = useQuery({
    ...environmentsQuery(projectId ?? "missing"),
    enabled: projectId !== null,
  });
  const origins = useQuery({
    ...originsQuery(projectId ?? "missing"),
    enabled: projectId !== null,
  });

  if (projectId === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Done</CardTitle>
          <CardDescription>Missing project context.</CardDescription>
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

  if (project.isPending) {
    return <RouteSkeleton lines={4} />;
  }
  if (project.isError || project.data === undefined) {
    return (
      <Alert variant="destructive" title="Could not load project">
        Please open the dashboard manually.
      </Alert>
    );
  }

  const prodEnv = envs.data?.find((e) => e.isDefault) ?? envs.data?.[0];
  const keyState =
    keyAcknowledged && secret !== null
      ? "Copied (acknowledged in the previous step; the key is no longer displayed)."
      : secret !== null
        ? "Shown in the previous step but not acknowledged — rotate it in settings if you lost it."
        : "No longer in memory (reload clears it) — rotate the key in settings if you need it.";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 aria-hidden="true" className="size-5 text-green-600" />{" "}
          You are set up
        </CardTitle>
        <CardDescription>
          Workspace and project are ready. Telemetry is honest: not configured
          yet.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="space-y-2">
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Workspace</dt>
            <dd className="font-mono text-xs">{project.data.workspaceId}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Project</dt>
            <dd className="font-medium">{project.data.name}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Environment</dt>
            <dd>
              {prodEnv !== undefined
                ? `${prodEnv.name}${prodEnv.isDefault ? " (default)" : ""}`
                : "Loading…"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Origins</dt>
            <dd>
              {origins.data !== undefined
                ? String(origins.data.length)
                : "Loading…"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-zinc-500">Key</dt>
            <dd className="max-w-xs text-right text-xs">{keyState}</dd>
          </div>
        </dl>
        <Alert title="Telemetry">
          Browser telemetry integration is not enabled in this build yet. No SDK
          snippet is shown on purpose.
        </Alert>
        <Button
          type="button"
          className="w-full"
          onClick={() => router.push(`/app/projects/${projectId}`)}
        >
          Go to project
        </Button>
      </CardContent>
    </Card>
  );
}
