"use client";

import { GeneralSettings } from "@/components/settings/general-settings";
import { useSettings } from "@/components/settings/settings-context";

export default function GeneralPage(): React.JSX.Element {
  const { projectId, role } = useSettings();
  return <GeneralSettings projectId={projectId} role={role} />;
}
