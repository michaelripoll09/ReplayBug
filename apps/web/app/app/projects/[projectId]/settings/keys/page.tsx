"use client";

import { KeysSettings } from "@/components/settings/keys-settings";
import { useSettings } from "@/components/settings/settings-context";

export default function KeysPage(): React.JSX.Element {
  const { projectId, role } = useSettings();
  return <KeysSettings projectId={projectId} role={role} />;
}
