import { redirect } from "next/navigation";
import { getServerSessionUser, apiFetchServer } from "@/lib/auth-server";

/**
 * Onboarding entry: backend is source of truth.
 * - new user (no workspace) -> workspace step
 * - workspace but no project -> project step for that workspace
 * - configured (workspace+project) -> app overview
 */
export default async function OnboardingIndex(): Promise<React.JSX.Element> {
  const user = await getServerSessionUser();
  if (user === null) {
    redirect("/login");
  }
  try {
    const wsRes = await apiFetchServer("/api/v1/workspaces");
    if (wsRes.ok) {
      const workspaces = (await wsRes.json()) as Array<{ id: string }>;
      if (workspaces.length === 0) {
        redirect("/onboarding/workspace");
      }
      const firstId = workspaces[0]?.id;
      if (firstId !== undefined) {
        const projRes = await apiFetchServer(
          `/api/v1/workspaces/${firstId}/projects`,
        );
        if (projRes.ok) {
          const projects = (await projRes.json()) as Array<{ id: string }>;
          if (projects.length === 0) {
            redirect(`/onboarding/project?workspaceId=${firstId}`);
          }
          redirect(`/app/workspaces/${firstId}`);
        }
      }
      redirect("/onboarding/workspace");
    }
  } catch {
    // fall through to workspace step on transient errors
  }
  redirect("/onboarding/workspace");
}
