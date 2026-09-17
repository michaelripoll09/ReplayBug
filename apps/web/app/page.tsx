import { redirect } from "next/navigation";
import { getServerSessionUser, apiFetchServer } from "@/lib/auth-server";

/**
 * Smart root: no session -> /login; session + no workspace -> onboarding;
 * otherwise the first workspace overview. URL stays the source of truth.
 */
export default async function HomePage(): Promise<React.JSX.Element> {
  const user = await getServerSessionUser();
  if (user === null) {
    redirect("/login");
  }
  let workspaceId: string | null = null;
  try {
    const res = await apiFetchServer("/api/v1/workspaces");
    if (res.ok) {
      const items = (await res.json()) as Array<{ id: string }>;
      workspaceId = items[0]?.id ?? null;
    }
  } catch {
    workspaceId = null;
  }
  if (workspaceId === null) {
    redirect("/onboarding/workspace");
  }
  redirect(`/app/workspaces/${workspaceId}`);
}
