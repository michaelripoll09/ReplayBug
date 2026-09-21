"use client";

import { EnvironmentsSettings } from "@/components/settings/environments-settings";
import { useSettings } from "@/components/settings/settings-context";

export default function EnvironmentsPage(): React.JSX.Element {
  const { projectId, role } = useSettings();
  return <EnvironmentsSettings projectId={projectId} role={role} />;
}
