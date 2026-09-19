"use client";

import { KeysSettings } from "@/components/settings/keys-settings";
import { SecretTokensSettings } from "@/components/settings/secret-tokens-settings";
import { useSettings } from "@/components/settings/settings-context";

/**
 * Keys & Tokens: the browser-safe public ingest key (write-only telemetry)
 * next to the CLI/CI-only secret project tokens (releases, source-map
 * uploads). The two credential classes stay visually and textually separate
 * so secret tokens never end up in frontend code.
 */
export default function KeysPage(): React.JSX.Element {
  const { projectId, role } = useSettings();
  return (
    <div className="space-y-8">
      <section aria-labelledby="public-key-heading" className="space-y-4">
        <div>
          <h2
            id="public-key-heading"
            className="text-base font-semibold tracking-tight"
          >
            Public ingest key
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Browser-safe, write-only telemetry key for the SDK.
          </p>
        </div>
        <KeysSettings projectId={projectId} role={role} />
      </section>
      <section aria-labelledby="secret-tokens-heading" className="space-y-4">
        <div>
          <h2
            id="secret-tokens-heading"
            className="text-base font-semibold tracking-tight"
          >
            Secret project tokens
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            CLI/CI-only credentials. Never use them in frontend code.
          </p>
        </div>
        <SecretTokensSettings projectId={projectId} role={role} />
      </section>
    </div>
  );
}
