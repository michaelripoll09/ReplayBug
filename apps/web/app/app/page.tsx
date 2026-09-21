import { redirect } from "next/navigation";
import { apiFetchServer } from "@/lib/auth-server";

/** /app entry: first workspace or onboarding. */
export default async function AppIndex(): Promise<React.JSX.Element> {
  try {
    const res = await apiFetchServer("/api/v1/workspaces");
    if (res.ok) {
      const items = (await res.json()) as Array<{ id: string }>;
      if (items[0]?.id !== undefined) {
        redirect(`/app/workspaces/${items[0].id}`);
      }
    }
  } catch {
    // fall through
  }
  redirect("/onboarding/workspace");
}
