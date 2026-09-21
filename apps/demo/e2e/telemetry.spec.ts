import { expect, test } from "@playwright/test";
import { e2eFixture, pollUntil, withPool } from "./helpers";

const fixture = e2eFixture();

interface EventRow {
  event_type: string;
  payload_json: Record<string, unknown>;
  telemetry_session_id: string;
  processing_state: string;
  outbox_event_id: string | null;
  dispatched_at: string | null;
}

/**
 * Events persisted for this project since the given instant. Scoping by
 * time keeps each test's assertions isolated even though all tests share
 * one seeded project and one demo server DSN.
 */
async function fetchEvents(since: Date): Promise<EventRow[]> {
  return withPool(async (pool) => {
    const res = await pool.query(
      `SELECT e.event_type, e.payload_json, e.telemetry_session_id,
              e.processing_state, o.event_id AS outbox_event_id, o.dispatched_at
       FROM events e
       LEFT JOIN event_processing_outbox o ON o.event_id = e.id
       WHERE e.project_id = $1 AND e.received_at >= $2
       ORDER BY e.received_at`,
      [fixture.projectId, since],
    );
    return res.rows as EventRow[];
  });
}

async function waitForEventTypes(
  since: Date,
  expected: string[],
): Promise<EventRow[]> {
  return pollUntil(async () => {
    const events = await fetchEvents(since);
    const types = new Set(events.map((e) => e.event_type));
    return expected.every((type) => types.has(type)) ? events : null;
  });
}

test.describe("Block 4 telemetry E2E (real browser → SDK → API → PostgreSQL)", () => {
  test("persists session, navigation, click and exception end to end", async ({
    page,
  }) => {
    const testStart = new Date();
    // The demo app itself has no unexpected SDK failures: collect console
    // errors and page errors, then assert none are attributed to the SDK.
    const sdkConsoleProblems: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" && msg.text().includes("[ReplayBug]")) {
        sdkConsoleProblems.push(msg.text());
      }
    });
    page.on("pageerror", (error) => {
      if (String(error).includes("ReplayBug")) {
        sdkConsoleProblems.push(String(error));
      }
    });

    await page.goto("/");
    await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
      "Enabled",
    );

    // Real navigation performed by the browser (hash change).
    await page.evaluate(() => {
      window.location.hash = "e2e-navigation-step";
    });
    // Real click; the demo button also triggers the intentional exception.
    await page
      .getByRole("button", { name: /1\. JavaScript Exception/ })
      .click();
    await expect(page.getByText(/Exception captured:/)).toBeVisible();

    const events = await waitForEventTypes(testStart, [
      "exception",
      "navigation",
      "click",
    ]);

    // All events of this test belong to exactly one telemetry session.
    const sessionIds = new Set(events.map((e) => e.telemetry_session_id));
    expect(sessionIds.size).toBe(1);
    const sessions = await withPool((pool) =>
      pool.query(`SELECT * FROM telemetry_sessions WHERE id = $1`, [
        [...sessionIds][0],
      ]),
    );
    expect(sessions.rows.length).toBe(1);
    const session = sessions.rows[0];
    expect(session.project_id).toBe(fixture.projectId);
    expect(session.environment).toBe("e2e");
    expect(session.release).toBe("demo-e2e@0.1.0");
    expect(session.browser_name).toBeTruthy();
    expect(session.initial_url).toContain("localhost:5173");

    // Every event is pending and has an undispatched outbox row
    // (no issue processing yet).
    expect(events.length).toBeGreaterThanOrEqual(3);
    for (const event of events) {
      expect(event.processing_state).toBe("pending");
      expect(event.outbox_event_id).not.toBeNull();
      expect(event.dispatched_at).toBeNull();
    }

    const exception = events.find((e) => e.event_type === "exception");
    const values = exception?.payload_json["values"] as Array<
      Record<string, unknown>
    >;
    expect(String(values[0]?.["value"])).toContain(
      "Cannot read properties of null",
    );

    const navigation = events.find(
      (e) =>
        e.event_type === "navigation" &&
        String(e.payload_json["to_url"]).includes("e2e-navigation-step"),
    );
    // A hash navigation is observed as popstate and/or hashchange depending
    // on the browser; both are valid navigation evidence.
    expect(String(navigation?.payload_json["navigation_type"])).toMatch(
      /^(hashchange|popstate)$/,
    );
    expect(String(navigation?.payload_json["to_url"])).toContain(
      "e2e-navigation-step",
    );

    const click = events.find((e) => e.event_type === "click");
    expect(click?.payload_json["element_tag"]).toBe("button");
    expect(String(click?.payload_json["accessible_name"])).toContain(
      "JavaScript Exception",
    );

    // No unexpected ReplayBug SDK errors surfaced in the browser console.
    expect(sdkConsoleProblems).toEqual([]);
  });

  test("persists unhandled rejection, console error and failed fetch 500", async ({
    page,
  }) => {
    const testStart = new Date();
    await page.goto("/");
    await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
      "Enabled",
    );

    await page
      .getByRole("button", { name: /2\. Unhandled Promise Rejection/ })
      .click();
    await page.getByRole("button", { name: /3\. Console Error/ }).click();
    await page.getByRole("button", { name: /4\. Failed Fetch/ }).click();

    const events = await waitForEventTypes(testStart, [
      "unhandled_rejection",
      "console_error",
      "network",
    ]);

    const rejection = events.find(
      (e) => e.event_type === "unhandled_rejection",
    );
    expect(String(rejection?.payload_json["reason"])).toContain(
      "Intentional unhandled rejection",
    );

    const consoleError = events.find((e) => e.event_type === "console_error");
    expect(JSON.stringify(consoleError?.payload_json)).toContain(
      "Intentional console.error",
    );

    const network = events.find((e) => e.event_type === "network");
    expect(network?.payload_json["status_code"]).toBe(500);
    expect(String(network?.payload_json["url"])).toContain(
      "/api/demo/500-endpoint",
    );
  });
});
