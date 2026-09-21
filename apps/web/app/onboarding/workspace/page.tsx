"use client";

import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { workspacesQuery } from "@/lib/queries";
import { WorkspaceForm } from "@/components/workspace/workspace-form";
import { useOnboarding } from "@/components/onboarding/wizard-context";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

/** Step 1: create (or pick) a workspace. Owner role comes from the backend. */
export default function WorkspaceStep(): React.JSX.Element {
  const router = useRouter();
  const { setWorkspace } = useOnboarding();
  const { data, isPending } = useQuery(workspacesQuery());

  function continueWith(id: string): void {
    setWorkspace(id);
    router.push(`/onboarding/project?workspaceId=${id}`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create a workspace</CardTitle>
        <CardDescription>
          Workspaces are the top-level tenant. You become the owner
          automatically.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : data !== undefined && data.length > 0 ? (
          <div className="space-y-2">
            <h2 className="text-sm font-medium">
              Or continue with an existing workspace
            </h2>
            <ul className="space-y-2">
              {data.map((w) => (
                <li
                  key={w.id}
                  className="flex items-center justify-between rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
                >
                  <span className="text-sm font-medium">{w.name}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => continueWith(w.id)}
                  >
                    Continue
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <WorkspaceForm
          submitLabel="Create workspace and continue"
          onCreated={(id) => {
            setWorkspace(id);
            router.push(`/onboarding/project?workspaceId=${id}`);
          }}
        />
      </CardContent>
    </Card>
  );
}
