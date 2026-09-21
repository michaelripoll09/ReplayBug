/**
 * Deterministic public-demo seed. This is intentionally not an auth account:
 * the synthetic user has no account credentials or login session.
 */
import { createHash } from "node:crypto";
import {
  LocalArtifactStorage,
  buildArtifactStorageKey,
} from "@replaybug/artifacts";
import {
  createDbClient,
  hashPublicKey,
  loadDbConfigFromEnv,
} from "@replaybug/db";

const DEMO_MODE = "true";
const RESET_FLAG = "--reset";
const LOCK_NAME = "replaybug-demo-seed-v1";

const IDS = {
  user: "00000000-0000-4000-8000-000000000001",
  workspace: "00000000-0000-4000-8000-000000000002",
  project: "00000000-0000-4000-8000-000000000003",
  frontendProject: "00000000-0000-4000-8000-000000000022",
  key: "00000000-0000-4000-8000-000000000004",
  issue: "00000000-0000-4000-8000-000000000005",
  session: "00000000-0000-4000-8000-000000000006",
  event: "00000000-0000-4000-8000-000000000007",
  environment: "00000000-0000-4000-8000-000000000008",
  origin: "00000000-0000-4000-8000-000000000009",
  release: "00000000-0000-4000-8000-000000000010",
  investigatingIssue: "00000000-0000-4000-8000-000000000011",
  resolvedIssue: "00000000-0000-4000-8000-000000000012",
  ignoredIssue: "00000000-0000-4000-8000-000000000013",
  secondSession: "00000000-0000-4000-8000-000000000014",
  navigationEvent: "00000000-0000-4000-8000-000000000015",
  clickEvent: "00000000-0000-4000-8000-000000000016",
  inputEvent: "00000000-0000-4000-8000-000000000017",
  secondOccurrenceEvent: "00000000-0000-4000-8000-000000000018",
  pageErrorReproduction: "00000000-0000-4000-8000-000000000019",
  checkoutReproduction: "00000000-0000-4000-8000-000000000020",
  analysis: "00000000-0000-4000-8000-000000000021",
} as const;

const PUBLIC_KEY = "rb_pk_deadbeef_0123456789012345678901234567890123456789012";
const FINGERPRINT = "a".repeat(64);
const INVESTIGATING_FINGERPRINT = "b".repeat(64);
const RESOLVED_FINGERPRINT = "c".repeat(64);
const IGNORED_FINGERPRINT = "d".repeat(64);
const PAGE_ERROR_REPRODUCTION_IDEMPOTENCY_HASH = "e".repeat(64);
const CHECKOUT_REPRODUCTION_IDEMPOTENCY_HASH = "f".repeat(64);
const ANALYSIS_IDEMPOTENCY_HASH = "0".repeat(64);
const DEMO_MINIFIED_ASSET =
  'function r(){throw new TypeError("Demo checkout failure")}r();\n//# sourceMappingURL=demo.min.js.map\n';
const DEMO_SOURCE_MAP =
  '{"version":3,"file":"demo.min.js","sources":["demo.ts"],"names":[],"mappings":"AAAA"}';
const DEMO_EXCEPTION_PAYLOAD = {
  values: [
    {
      type: "TypeError",
      value: "Cannot read properties of undefined",
      stacktrace: {
        frames: [
          {
            filename: "https://demo.replaybug.dev/assets/demo.min.js",
            function: "submitCheckout",
            lineno: 1,
            colno: 20,
            in_app: true,
          },
        ],
      },
    },
  ],
} as const;
const DEMO_EXCEPTION_SYMBOLICATION = {
  status: "mapped",
  rawFrames: [
    {
      filename: "https://demo.replaybug.dev/assets/demo.min.js",
      function: "submitCheckout",
      lineno: 1,
      colno: 20,
      inApp: true,
    },
  ],
  mappedFrames: [
    {
      filename: "demo.ts",
      source: "demo.ts",
      function: "submitCheckout",
      name: "submitCheckout",
      line: 1,
      column: 1,
      inApplication: true,
      mapped: true,
    },
  ],
  mappedFrameCount: 1,
} as const;
const DEMO_ARTIFACTS = [
  {
    artifactPath: "assets/demo.min.js",
    artifactType: "minified_asset",
    contents: DEMO_MINIFIED_ASSET,
  },
  {
    artifactPath: "assets/demo.min.js.map",
    artifactType: "source_map",
    contents: DEMO_SOURCE_MAP,
  },
] as const;

async function* artifactBytes(contents: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(contents);
}

function nowRelativeTimestamp(): string {
  return new Date().toISOString();
}

function timestampAtOffset(seededAt: string, offsetMs: number): string {
  return new Date(new Date(seededAt).getTime() + offsetMs).toISOString();
}

function requireDemoMode(): void {
  if (process.env["REPLAYBUG_DEMO_MODE"] !== DEMO_MODE) {
    throw new Error(
      "Set REPLAYBUG_DEMO_MODE=true before seeding the public demo.",
    );
  }
}

async function main(): Promise<void> {
  requireDemoMode();

  const artifactStorage = LocalArtifactStorage.fromEnv();
  const seededAt = nowRelativeTimestamp();
  const secondSessionStartedAt = timestampAtOffset(seededAt, -4 * 60_000);
  const navigationOccurredAt = timestampAtOffset(seededAt, -3 * 60_000);
  const clickOccurredAt = timestampAtOffset(seededAt, -2 * 60_000);
  const inputOccurredAt = timestampAtOffset(seededAt, -60_000);
  const secondOccurrenceAt = timestampAtOffset(seededAt, 0);
  const config = loadDbConfigFromEnv(process.env);
  const client = createDbClient({ ...config, maxConnections: 1 });
  const connection = await client.pool.connect();

  try {
    await connection.query("SELECT pg_advisory_lock(hashtext($1))", [
      LOCK_NAME,
    ]);
    await connection.query("BEGIN");

    if (process.argv.includes(RESET_FLAG)) {
      await connection.query(
        `DELETE FROM workspaces
         WHERE id = $1 AND is_public_demo = TRUE`,
        [IDS.workspace],
      );
    }

    await connection.query(
      `INSERT INTO "user" (id, name, email, email_verified)
       VALUES ($1, $2, $3, FALSE)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           email = EXCLUDED.email,
           email_verified = EXCLUDED.email_verified`,
      [IDS.user, "Public Demo Synthetic User", "demo-user@invalid.test"],
    );

    await connection.query(
      `INSERT INTO workspaces (id, name, slug, is_public_demo, created_by_user_id)
       VALUES ($1, $2, $3, TRUE, $4)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           slug = EXCLUDED.slug,
           is_public_demo = TRUE,
           created_by_user_id = EXCLUDED.created_by_user_id`,
      [IDS.workspace, "ReplayBug Public Demo", "public-demo", IDS.user],
    );

    await connection.query(
      `INSERT INTO projects (id, workspace_id, name, slug, description, timezone, retention_days)
       VALUES ($1, $2, $3, $4, $5, 'UTC', 30)
       ON CONFLICT (id) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id,
           name = EXCLUDED.name,
           slug = EXCLUDED.slug,
           description = EXCLUDED.description,
           timezone = EXCLUDED.timezone,
           retention_days = EXCLUDED.retention_days`,
      [
        IDS.project,
        IDS.workspace,
        "Public Demo",
        "public-demo",
        "Synthetic public demo data.",
      ],
    );

    await connection.query(
      `INSERT INTO projects (id, workspace_id, name, slug, description, timezone, retention_days)
       VALUES ($1, $2, $3, $4, $5, 'UTC', 30)
       ON CONFLICT (id) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id,
           name = EXCLUDED.name,
           slug = EXCLUDED.slug,
           description = EXCLUDED.description,
           timezone = EXCLUDED.timezone,
           retention_days = EXCLUDED.retention_days`,
      [
        IDS.frontendProject,
        IDS.workspace,
        "Public Demo Frontend",
        "public-demo-frontend",
        "Synthetic frontend demo project without public ingest data.",
      ],
    );

    await connection.query(
      `INSERT INTO project_environments (id, project_id, name, base_url, is_default)
       VALUES ($1, $2, 'production', $3, TRUE)
       ON CONFLICT (id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           name = EXCLUDED.name,
           base_url = EXCLUDED.base_url,
           is_default = EXCLUDED.is_default`,
      [IDS.environment, IDS.project, "http://localhost:5173"],
    );

    await connection.query(
      `INSERT INTO project_origins (id, project_id, origin, is_enabled)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           origin = EXCLUDED.origin,
           is_enabled = EXCLUDED.is_enabled`,
      [IDS.origin, IDS.project, "http://localhost:5173"],
    );

    await connection.query(
      `INSERT INTO project_keys (id, project_id, kind, name, prefix, key_hash)
       VALUES ($1, $2, 'public_ingest', $3, 'deadbeef', $4)
       ON CONFLICT (id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           kind = EXCLUDED.kind,
           name = EXCLUDED.name,
           prefix = EXCLUDED.prefix,
           key_hash = EXCLUDED.key_hash,
           revoked_at = NULL`,
      [
        IDS.key,
        IDS.project,
        "Public demo ingest key",
        hashPublicKey(PUBLIC_KEY),
      ],
    );

    await connection.query(
      `INSERT INTO releases (id, project_id, version, created_at)
       VALUES ($1, $2, 'demo-1.0.0', $3)
       ON CONFLICT (id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           version = EXCLUDED.version,
           created_at = EXCLUDED.created_at`,
      [IDS.release, IDS.project, seededAt],
    );

    for (const artifact of DEMO_ARTIFACTS) {
      const expectedContentHash = createHash("sha256")
        .update(artifact.contents)
        .digest("hex");
      const storageKey = buildArtifactStorageKey(
        IDS.project,
        IDS.release,
        expectedContentHash,
      );
      const stored = await artifactStorage.put(
        storageKey,
        artifactBytes(artifact.contents),
      );

      if (stored.contentHash !== expectedContentHash) {
        throw new Error("Stored demo artifact content hash did not match");
      }

      await connection.query(
        `INSERT INTO release_artifacts (
           release_id, artifact_path, storage_key, content_hash, size_bytes, artifact_type
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (release_id, artifact_path) DO UPDATE
         SET storage_key = EXCLUDED.storage_key,
             content_hash = EXCLUDED.content_hash,
             size_bytes = EXCLUDED.size_bytes,
             artifact_type = EXCLUDED.artifact_type`,
        [
          IDS.release,
          artifact.artifactPath,
          storageKey,
          stored.contentHash,
          stored.sizeBytes,
          artifact.artifactType,
        ],
      );
    }

    await connection.query(
      `INSERT INTO telemetry_sessions (
         id, project_id, sdk_session_id, environment, release, started_at,
         last_seen_at, initial_url, browser_name, os_name, device_type, sdk_version
       )
       VALUES ($1, $2, $3, 'production', 'demo-1.0.0', $4, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           sdk_session_id = EXCLUDED.sdk_session_id,
           environment = EXCLUDED.environment,
           release = EXCLUDED.release,
           started_at = EXCLUDED.started_at,
           last_seen_at = EXCLUDED.last_seen_at,
           initial_url = EXCLUDED.initial_url,
           browser_name = EXCLUDED.browser_name,
           os_name = EXCLUDED.os_name,
           device_type = EXCLUDED.device_type,
           sdk_version = EXCLUDED.sdk_version`,
      [
        IDS.session,
        IDS.project,
        "public-demo-session-1",
        seededAt,
        "https://demo.replaybug.dev/checkout",
        "Chrome",
        "Linux",
        "desktop",
        "1.0.0",
      ],
    );

    await connection.query(
      `INSERT INTO telemetry_sessions (
         id, project_id, sdk_session_id, environment, release, started_at,
         last_seen_at, initial_url, browser_name, os_name, device_type, sdk_version
       )
       VALUES ($1, $2, $3, 'production', 'demo-1.0.0', $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           sdk_session_id = EXCLUDED.sdk_session_id,
           environment = EXCLUDED.environment,
           release = EXCLUDED.release,
           started_at = EXCLUDED.started_at,
           last_seen_at = EXCLUDED.last_seen_at,
           initial_url = EXCLUDED.initial_url,
           browser_name = EXCLUDED.browser_name,
           os_name = EXCLUDED.os_name,
           device_type = EXCLUDED.device_type,
           sdk_version = EXCLUDED.sdk_version`,
      [
        IDS.secondSession,
        IDS.project,
        "public-demo-session-2",
        secondSessionStartedAt,
        secondOccurrenceAt,
        "https://demo.replaybug.dev/checkout",
        "Chrome",
        "Linux",
        "desktop",
        "1.0.0",
      ],
    );

    await connection.query(
      `INSERT INTO issues (
         id, project_id, fingerprint, fingerprint_signature, type, title,
         normalized_message, status, severity, first_seen_at, last_seen_at,
         first_release, last_release, occurrence_count, affected_session_count
       )
       VALUES ($1, $2, $3, $4, 'exception', $5, $6, 'open', 'error', $7, $8, $9, $9, 2, 2)
       ON CONFLICT (id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           fingerprint = EXCLUDED.fingerprint,
           fingerprint_signature = EXCLUDED.fingerprint_signature,
           type = EXCLUDED.type,
           title = EXCLUDED.title,
           normalized_message = EXCLUDED.normalized_message,
           status = EXCLUDED.status,
           severity = EXCLUDED.severity,
           first_seen_at = EXCLUDED.first_seen_at,
           last_seen_at = EXCLUDED.last_seen_at,
           first_release = EXCLUDED.first_release,
           last_release = EXCLUDED.last_release,
           occurrence_count = EXCLUDED.occurrence_count,
           affected_session_count = EXCLUDED.affected_session_count`,
      [
        IDS.issue,
        IDS.project,
        FINGERPRINT,
        "public-demo:checkout:TypeError",
        "Checkout failed",
        "Cannot read properties of undefined",
        seededAt,
        secondOccurrenceAt,
        "demo-1.0.0",
      ],
    );

    for (const issue of [
      {
        id: IDS.investigatingIssue,
        fingerprint: INVESTIGATING_FINGERPRINT,
        fingerprintSignature: "public-demo:catalog:NetworkError",
        title: "Catalog request delayed",
        message:
          "Synthetic catalog request exceeded the expected response time",
        status: "investigating",
      },
      {
        id: IDS.resolvedIssue,
        fingerprint: RESOLVED_FINGERPRINT,
        fingerprintSignature: "public-demo:profile:ValidationError",
        title: "Profile preference validation",
        message: "Synthetic profile preference validation was corrected",
        status: "resolved",
      },
      {
        id: IDS.ignoredIssue,
        fingerprint: IGNORED_FINGERPRINT,
        fingerprintSignature: "public-demo:analytics:AbortError",
        title: "Analytics request cancelled",
        message: "Synthetic analytics request was cancelled during navigation",
        status: "ignored",
      },
    ] as const) {
      await connection.query(
        `INSERT INTO issues (
           id, project_id, fingerprint, fingerprint_signature, type, title,
           normalized_message, status, severity, first_seen_at, last_seen_at,
           first_release, last_release, occurrence_count, affected_session_count
         )
         VALUES ($1, $2, $3, $4, 'exception', $5, $6, $7, 'error', $8, $8, $9, $9, 1, 0)
         ON CONFLICT (id) DO UPDATE
         SET project_id = EXCLUDED.project_id,
             fingerprint = EXCLUDED.fingerprint,
             fingerprint_signature = EXCLUDED.fingerprint_signature,
             type = EXCLUDED.type,
             title = EXCLUDED.title,
             normalized_message = EXCLUDED.normalized_message,
             status = EXCLUDED.status,
             severity = EXCLUDED.severity,
             first_seen_at = EXCLUDED.first_seen_at,
             last_seen_at = EXCLUDED.last_seen_at,
             first_release = EXCLUDED.first_release,
             last_release = EXCLUDED.last_release,
             occurrence_count = EXCLUDED.occurrence_count,
             affected_session_count = EXCLUDED.affected_session_count`,
        [
          issue.id,
          IDS.project,
          issue.fingerprint,
          issue.fingerprintSignature,
          issue.title,
          issue.message,
          issue.status,
          seededAt,
          "demo-1.0.0",
        ],
      );
    }

    await connection.query(
      `INSERT INTO events (
         id, project_id, telemetry_session_id, client_event_id, sequence_number,
         event_type, occurred_at, environment, release, page_url, payload_json,
         symbolication_json, fingerprint, issue_id, processing_state
       )
       VALUES ($1, $2, $3, $4, 1, 'exception', $5, 'production', 'demo-1.0.0', $6, $7::jsonb, $8::jsonb, $9, $10, 'processed')
       ON CONFLICT (id) DO UPDATE
       SET project_id = EXCLUDED.project_id,
           telemetry_session_id = EXCLUDED.telemetry_session_id,
           client_event_id = EXCLUDED.client_event_id,
           sequence_number = EXCLUDED.sequence_number,
           event_type = EXCLUDED.event_type,
           occurred_at = EXCLUDED.occurred_at,
           environment = EXCLUDED.environment,
           release = EXCLUDED.release,
           page_url = EXCLUDED.page_url,
           payload_json = EXCLUDED.payload_json,
           symbolication_json = EXCLUDED.symbolication_json,
           fingerprint = EXCLUDED.fingerprint,
           issue_id = EXCLUDED.issue_id,
           processing_state = EXCLUDED.processing_state,
           rejection_reason = NULL`,
      [
        IDS.event,
        IDS.project,
        IDS.session,
        "public-demo-event-1",
        seededAt,
        "https://demo.replaybug.dev/checkout",
        JSON.stringify(DEMO_EXCEPTION_PAYLOAD),
        JSON.stringify(DEMO_EXCEPTION_SYMBOLICATION),
        FINGERPRINT,
        IDS.issue,
      ],
    );

    for (const event of [
      {
        id: IDS.navigationEvent,
        clientEventId: "public-demo-event-2",
        sequenceNumber: 1,
        eventType: "navigation",
        occurredAt: navigationOccurredAt,
        pageUrl: "https://demo.replaybug.dev/checkout",
        payload: {
          from_url: "https://demo.replaybug.dev/catalog",
          to_url: "https://demo.replaybug.dev/checkout",
          navigation_type: "pushState",
        },
        fingerprint: null,
        issueId: null,
      },
      {
        id: IDS.clickEvent,
        clientEventId: "public-demo-event-3",
        sequenceNumber: 2,
        eventType: "click",
        occurredAt: clickOccurredAt,
        pageUrl: "https://demo.replaybug.dev/checkout",
        payload: {
          locator_candidates: [
            {
              type: "test_id",
              value: "checkout-submit",
              confidence: 1,
            },
          ],
          element_tag: "button",
          element_role: "button",
          accessible_name: "Place order",
          route: "/checkout",
        },
        fingerprint: null,
        issueId: null,
      },
      {
        id: IDS.inputEvent,
        clientEventId: "public-demo-event-4",
        sequenceNumber: 3,
        eventType: "input",
        occurredAt: inputOccurredAt,
        pageUrl: "https://demo.replaybug.dev/checkout",
        payload: {
          input_type: "password",
          has_value: false,
          value_not_captured: true,
        },
        fingerprint: null,
        issueId: null,
      },
      {
        id: IDS.secondOccurrenceEvent,
        clientEventId: "public-demo-event-5",
        sequenceNumber: 4,
        eventType: "exception",
        occurredAt: secondOccurrenceAt,
        pageUrl: "https://demo.replaybug.dev/checkout",
        payload: DEMO_EXCEPTION_PAYLOAD,
        fingerprint: FINGERPRINT,
        issueId: IDS.issue,
      },
    ] as const) {
      await connection.query(
        `INSERT INTO events (
           id, project_id, telemetry_session_id, client_event_id, sequence_number,
           event_type, occurred_at, environment, release, page_url, payload_json,
           fingerprint, issue_id, processing_state
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'production', 'demo-1.0.0', $8, $9::jsonb, $10, $11, 'processed')
         ON CONFLICT (id) DO UPDATE
         SET project_id = EXCLUDED.project_id,
             telemetry_session_id = EXCLUDED.telemetry_session_id,
             client_event_id = EXCLUDED.client_event_id,
             sequence_number = EXCLUDED.sequence_number,
             event_type = EXCLUDED.event_type,
             occurred_at = EXCLUDED.occurred_at,
             environment = EXCLUDED.environment,
             release = EXCLUDED.release,
             page_url = EXCLUDED.page_url,
             payload_json = EXCLUDED.payload_json,
             fingerprint = EXCLUDED.fingerprint,
             issue_id = EXCLUDED.issue_id,
             processing_state = EXCLUDED.processing_state,
             rejection_reason = NULL`,
        [
          event.id,
          IDS.project,
          IDS.secondSession,
          event.clientEventId,
          event.sequenceNumber,
          event.eventType,
          event.occurredAt,
          event.pageUrl,
          JSON.stringify(event.payload),
          event.fingerprint,
          event.issueId,
        ],
      );
    }

    await connection.query(
      `INSERT INTO reproduction_tests (
         id, issue_id, event_id, generated_by_user_id, language, framework,
         code, has_redacted_steps, generator_version, status, completed_at,
         idempotency_key_hash
       )
       VALUES ($1, $2, $3, $4, 'typescript', 'playwright', $5, TRUE, '1.0.0', 'ready', $6, $7)
       ON CONFLICT (id) DO UPDATE
       SET issue_id = EXCLUDED.issue_id,
           event_id = EXCLUDED.event_id,
           generated_by_user_id = EXCLUDED.generated_by_user_id,
           language = EXCLUDED.language,
           framework = EXCLUDED.framework,
           code = EXCLUDED.code,
           has_redacted_steps = EXCLUDED.has_redacted_steps,
           generator_version = EXCLUDED.generator_version,
           status = EXCLUDED.status,
           error_code = NULL,
           error_message = NULL,
           completed_at = EXCLUDED.completed_at,
           idempotency_key_hash = EXCLUDED.idempotency_key_hash`,
      [
        IDS.pageErrorReproduction,
        IDS.issue,
        IDS.event,
        IDS.user,
        `import { expect, test } from "@playwright/test";

test("reproduces the synthetic checkout page error", async ({ page }) => {
  const pageError = page.waitForEvent("pageerror");

  await page.goto("http://localhost:5173/checkout");
  await page.getByTestId('demo-uncaught-error').click();

  const error = await pageError;
  expect(error.message).toContain("Synthetic checkout failure");
});`,
        seededAt,
        PAGE_ERROR_REPRODUCTION_IDEMPOTENCY_HASH,
      ],
    );

    await connection.query(
      `INSERT INTO reproduction_tests (
         id, issue_id, event_id, generated_by_user_id, language, framework,
         code, has_redacted_steps, generator_version, status, completed_at,
         idempotency_key_hash
       )
       VALUES ($1, $2, $3, $4, 'typescript', 'playwright', $5, FALSE, '1.0.0', 'ready', $6, $7)
       ON CONFLICT (id) DO UPDATE
       SET issue_id = EXCLUDED.issue_id,
           event_id = EXCLUDED.event_id,
           generated_by_user_id = EXCLUDED.generated_by_user_id,
           language = EXCLUDED.language,
           framework = EXCLUDED.framework,
           code = EXCLUDED.code,
           has_redacted_steps = EXCLUDED.has_redacted_steps,
           generator_version = EXCLUDED.generator_version,
           status = EXCLUDED.status,
           error_code = NULL,
           error_message = NULL,
           completed_at = EXCLUDED.completed_at,
           idempotency_key_hash = EXCLUDED.idempotency_key_hash`,
      [
        IDS.checkoutReproduction,
        IDS.issue,
        IDS.clickEvent,
        IDS.user,
        `import { expect, test } from "@playwright/test";

test("reaches the synthetic checkout flow", async ({ page }) => {
  await page.goto("http://localhost:5173");
  await page.getByRole('button', { name: 'Checkout' }).click();

  await expect(page).toHaveURL(/checkout/);
});`,
        seededAt,
        CHECKOUT_REPRODUCTION_IDEMPOTENCY_HASH,
      ],
    );

    await connection.query(
      `INSERT INTO ai_analyses (
         id, issue_id, event_id, model, status, summary, suspected_cause,
         evidence_json, reproduction_steps_json, limitations_json,
         requested_by_user_id, analysis_version, idempotency_key_hash, completed_at
       )
       VALUES ($1, $2, $3, 'synthetic-demo', 'ready', $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, '1.0.0', $10, $11)
       ON CONFLICT (id) DO UPDATE
       SET issue_id = EXCLUDED.issue_id,
           event_id = EXCLUDED.event_id,
           model = EXCLUDED.model,
           status = EXCLUDED.status,
           summary = EXCLUDED.summary,
           suspected_cause = EXCLUDED.suspected_cause,
           evidence_json = EXCLUDED.evidence_json,
           reproduction_steps_json = EXCLUDED.reproduction_steps_json,
           limitations_json = EXCLUDED.limitations_json,
           error_code = NULL,
           error_message = NULL,
           requested_by_user_id = EXCLUDED.requested_by_user_id,
           analysis_version = EXCLUDED.analysis_version,
           idempotency_key_hash = EXCLUDED.idempotency_key_hash,
           completed_at = EXCLUDED.completed_at`,
      [
        IDS.analysis,
        IDS.issue,
        IDS.event,
        "Synthetic checkout failure is reproducible from the demo fixture.",
        "The synthetic checkout control deliberately emits a page error.",
        JSON.stringify([
          {
            ref: `event:${IDS.event}`,
            reason: "Synthetic TypeError event is linked to the open issue.",
          },
        ]),
        JSON.stringify([
          "Open the synthetic checkout page.",
          "Trigger the demo checkout error control.",
          "Observe the synthetic page error.",
        ]),
        JSON.stringify([
          "This analysis uses synthetic public-demo telemetry only.",
          "It does not identify a production root cause.",
        ]),
        IDS.user,
        ANALYSIS_IDEMPOTENCY_HASH,
        seededAt,
      ],
    );

    await connection.query("COMMIT");
    console.log("Public demo seed complete.");
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await connection
      .query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_NAME])
      .catch(() => undefined);
    connection.release();
    await client.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
