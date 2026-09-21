"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ProjectForm } from "@/components/project/project-form";
import { OneTimeSecret } from "@/components/secrets/one-time-secret";
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

/**
 * Step 2: create a project. The plaintext key lives in wizard memory only;
 * continue drops the display (but keeps memory for the complete screen's
 * "copied" state) — reload wipes it.
 */
export default function ProjectStep(): React.JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const workspaceId = params.get("workspaceId");
  const {
    workspaceId: ctxWorkspace,
    setWorkspace,
    setProject,
    secret,
    keyAcknowledged,
    acknowledgeKey,
  } = useOnboarding();
  const effectiveWorkspace = workspaceId ?? ctxWorkspace;
  const [createdId, setCreatedId] = React.useState<string | null>(null);
  const [createdName, setCreatedName] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (workspaceId !== null && workspaceId !== ctxWorkspace) {
      setWorkspace(workspaceId);
    }
  }, [workspaceId, ctxWorkspace, setWorkspace]);

  if (effectiveWorkspace === null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Create a project</CardTitle>
          <CardDescription>Pick a workspace first.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            type="button"
            onClick={() => router.push("/onboarding/workspace")}
          >
            Back to workspace
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (createdId !== null && secret !== null) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Copy your public ingest key</CardTitle>
          <CardDescription>
            Project “{createdName}” created. This key is shown once — copy it
            now.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <OneTimeSecret
            secret={secret}
            label={`Public ingest key for ${createdName ?? "project"}`}
            hint="Copy it now. It will never be shown again. Browser telemetry integration is not enabled in this build yet."
          />
          <Alert title="What this key is">
            A public ingest key ({createdId.slice(0, 8)}…) that can only send
            telemetry to this project. It cannot read data. You may also show
            the project ID, key prefix, environment and origin in your own notes
            — but never commit the full key.
          </Alert>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Browser telemetry integration is not enabled in this build yet — no
            SDK snippet is shown.
          </p>
          <Button
            type="button"
            className="w-full"
            onClick={() => {
              acknowledgeKey();
              router.push(`/onboarding/origin?projectId=${createdId}`);
            }}
          >
            I copied the key — continue
          </Button>
          <p className="text-center text-xs text-zinc-500" role="status">
            {keyAcknowledged
              ? "Acknowledged."
              : "The key stays in memory until you reload."}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a project</CardTitle>
        <CardDescription>
          A production environment is created automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ProjectForm
          workspaceId={effectiveWorkspace}
          submitLabel="Create project"
          onCreated={(created, nextSecret) => {
            setCreatedId(created.id);
            setCreatedName(created.name);
            setProject(created.id, created.name, nextSecret);
          }}
        />
      </CardContent>
    </Card>
  );
}
