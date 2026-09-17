"use client";

import { OriginsSettings } from "@/components/settings/origins-settings";
import { useSettings } from "@/components/settings/settings-context";

export default function OriginsPage(): React.JSX.Element {
  const { projectId, role } = useSettings();
  return <OriginsSettings projectId={projectId} role={role} />;
}
