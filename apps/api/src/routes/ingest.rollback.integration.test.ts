import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/**
 * Transaction rollback proof.
 *
 * Forces the outbox insert to fail (repository-level failure injection, no
 * testing endpoint) and verifies the ingest transaction rolls back: no
 * orphan event row and no inconsistently created telemetry session.
 */
vi.mock("@replaybug/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@replaybug/db")>();
  return {
    ...actual,
    insertOutbox: vi.fn(async () => {
      throw new Error("forced outbox insert failure (test)");
    }),
  };
});

import { buildApp } from "../app.js";
import type { AppInstance } from "../instance.js";
import type { DbClient } from "@replaybug/db";
import {
  cookiesHeader,
  createTestDbClient,
  resetTestDatabase,
  testApiConfig,
} from "../test-helpers.js";

const PASSWORD = "TestPass123!";
const CONFIGURED_ORIGIN = "http://localhost:5173";

describe("Block 4 ingest transaction rollback (real PG)", () => {
  let app: AppInstance;
  let dbClient: DbClient;

  beforeAll(async () => {
    dbClient = createTestDbClient();
    app = await buildApp({ config: testApiConfig(), dbClient });
  });

  beforeEach(async () => {
    await resetTestDatabase(dbClient);
  });

  afterAll(async () => {
    await app.close();
    await dbClient.close();
  });

  it("rolls back the event and session when outbox insertion fails", async () => {
    // Real project through the public API.
    const signup = await app.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: {
        email: `rollback-${randomUUID()}@example.com`,
        password: PASSWORD,
        name: "Rollback Tester",
      },
    });
    const raw = signup.headers["set-cookie"];
    const cookie = cookiesHeader(
      Array.isArray(raw) ? raw : raw ? [String(raw)] : [],
    );
    const ws = (
      await app.inject({
        method: "POST",
        url: "/api/v1/workspaces",
        headers: { cookie },
        payload: { name: "Rollback WS" },
      })
    ).json() as { id: string };
    const created = (
      await app.inject({
        method: "POST",
        url: `/api/v1/workspaces/${ws.id}/projects`,
        headers: { cookie },
        payload: { name: "Rollback Proj" },
      })
    ).json() as { project: { id: string }; bootstrap: { key: string } };
    await app.inject({
      method: "POST",
      url: `/api/v1/projects/${created.project.id}/origins`,
      headers: { cookie },
      payload: { origin: CONFIGURED_ORIGIN },
    });

    const batch = {
      protocol_version: 1,
      sdk_name: "@replaybug/sdk",
      sdk_version: "0.2.0",
      session: {
        sdk_session_id: randomUUID(),
        browser: {
          name: "chromium",
          version: "120.0",
          os_name: "Windows",
          os_version: "11",
          device_type: "desktop",
          viewport_width: 1280,
          viewport_height: 720,
        },
        initial_url: `${CONFIGURED_ORIGIN}/`,
        environment: "test",
        release: "test@0.0.1",
      },
      events: [
        {
          event_id: randomUUID(),
          sequence_number: 0,
          event_type: "exception",
          timestamp: new Date().toISOString(),
          payload: { values: [{ type: "Error", value: "boom" }] },
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/ingest/v1/batch",
      headers: {
        "x-replaybug-key": created.bootstrap.key,
        origin: CONFIGURED_ORIGIN,
      },
      payload: batch,
    });

    // The per-event failure is counted, not surfaced as a 500.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      accepted: 0,
      duplicate: 0,
      rejected: 1,
    });

    // Transaction rolled back: no orphan event, no outbox row, and no
    // half-created telemetry session.
    const events = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS count FROM events WHERE project_id = $1`,
      [created.project.id],
    );
    expect(events.rows[0].count).toBe(0);

    const outbox = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS count FROM event_processing_outbox`,
    );
    expect(outbox.rows[0].count).toBe(0);

    const sessions = await dbClient.pool.query(
      `SELECT COUNT(*)::int AS count FROM telemetry_sessions WHERE project_id = $1`,
      [created.project.id],
    );
    expect(sessions.rows[0].count).toBe(0);
  });
});
