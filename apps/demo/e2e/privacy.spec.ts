import { expect, test } from "@playwright/test";
import { e2eFixture, pollUntil, withPool } from "./helpers";

const fixture = e2eFixture();

const SAFE_FIXTURE = "SAFE_REPLAYBUG_E2E_VALUE_92841";
const PASSWORD_FIXTURE = "PRIVATE_PASSWORD_E2E_92841";
const CARD_FIXTURE = "4111111111111111";
const TOKEN_FIXTURE = "PRIVATE_TOKEN_E2E_92841";
const MASKED_FIXTURE = "PRIVATE_MASKED_E2E_92841";
const IGNORED_FIXTURE = "PRIVATE_IGNORED_E2E_92841";
const RAW_USER_ID = "synthetic-user-123";
const JWT_FIXTURE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const BEARER_FIXTURE = "rb_bearer_fixture_token_0123456789abcdef";

test.describe("Block 4 privacy E2E", () => {
  test("persists only the safe fixture and the HMAC user hash", async ({
    page,
  }) => {
    const testStart = new Date();
    await page.goto("/");
    await expect(page.locator("p:has-text('Telemetry:')")).toContainText(
      "Enabled",
    );

    // Raw user identity: server must derive the HMAC hash and drop the ID.
    await page.getByRole("button", { name: /setUser\(/ }).click();

    // Privacy form fixtures.
    await page.getByPlaceholder(SAFE_FIXTURE).fill(SAFE_FIXTURE);
    await page.getByPlaceholder(PASSWORD_FIXTURE).fill(PASSWORD_FIXTURE);
    await page.getByPlaceholder(CARD_FIXTURE).fill(CARD_FIXTURE);
    await page.getByPlaceholder(TOKEN_FIXTURE).fill(TOKEN_FIXTURE);
    await page.getByPlaceholder(MASKED_FIXTURE).fill(MASKED_FIXTURE);
    await page.getByPlaceholder(IGNORED_FIXTURE).fill(IGNORED_FIXTURE);
    const jwtInput = page.locator('input[placeholder^="eyJhbGciOi"]');
    await jwtInput.fill(JWT_FIXTURE);
    await jwtInput.fill(BEARER_FIXTURE);

    // Submit: triggers an intentional exception which forces a flush.
    await page
      .getByRole("button", { name: /Submit & Trigger Exception/ })
      .click();
    await expect(page.getByText(/Privacy form submitted/)).toBeVisible();

    // Wait until this test's telemetry is persisted (scoped by time: all
    // tests share the seeded project).
    await pollUntil(async () => {
      return withPool(async (pool) => {
        const res = await pool.query(
          `SELECT COUNT(*)::int AS count FROM events e
           INNER JOIN telemetry_sessions s ON s.id = e.telemetry_session_id
           WHERE e.project_id = $1 AND e.received_at >= $2
             AND s.started_at >= $2
             AND row_to_json(e)::text LIKE $3`,
          [fixture.projectId, testStart, `%${SAFE_FIXTURE}%`],
        );
        return res.rows[0].count > 0 ? true : null;
      });
    });

    // Scope the leak scan to telemetry from this test's sessions. Fixture
    // data from earlier tests must not influence this privacy assertion.
    const persisted = await withPool(async (pool) => {
      const sessions = await pool.query(
        `SELECT row_to_json(s) AS row FROM telemetry_sessions s
         WHERE s.project_id = $1 AND s.started_at >= $2`,
        [fixture.projectId, testStart],
      );
      const events = await pool.query(
        `SELECT row_to_json(e) AS row FROM events e
         INNER JOIN telemetry_sessions s ON s.id = e.telemetry_session_id
         WHERE e.project_id = $1 AND e.received_at >= $2
           AND s.started_at >= $2`,
        [fixture.projectId, testStart],
      );
      return JSON.stringify([...sessions.rows, ...events.rows]);
    });
    for (const secret of [
      PASSWORD_FIXTURE,
      CARD_FIXTURE,
      TOKEN_FIXTURE,
      MASKED_FIXTURE,
      IGNORED_FIXTURE,
      JWT_FIXTURE,
      BEARER_FIXTURE,
      RAW_USER_ID,
    ]) {
      expect(persisted).not.toContain(secret);
    }

    // The safe fixture may only appear in the allowed safe-input location:
    // input events whose safe-selector match flag is true.
    const wrongLocations = await withPool((pool) =>
      pool.query(
        `SELECT COUNT(*)::int AS count FROM events e
         INNER JOIN telemetry_sessions s ON s.id = e.telemetry_session_id
         WHERE e.project_id = $1 AND e.received_at >= $2
           AND s.started_at >= $2
           AND row_to_json(e)::text LIKE $3
           AND (e.event_type <> 'input'
                OR e.payload_json->>'is_safe_selector_match' <> 'true')`,
        [fixture.projectId, testStart, `%${SAFE_FIXTURE}%`],
      ),
    );
    expect(wrongLocations.rows[0].count).toBe(0);

    const safeEvents = await withPool((pool) =>
      pool.query(
        `SELECT e.payload_json->>'value' AS value FROM events e
         INNER JOIN telemetry_sessions s ON s.id = e.telemetry_session_id
         WHERE e.project_id = $1 AND e.received_at >= $2
           AND s.started_at >= $2 AND e.event_type = 'input'
           AND e.payload_json->>'is_safe_selector_match' = 'true'`,
        [fixture.projectId, testStart],
      ),
    );
    expect(safeEvents.rows.length).toBeGreaterThan(0);
    expect(
      safeEvents.rows.map((r: { value: string | null }) => r.value),
    ).toContain(SAFE_FIXTURE);

    // HMAC user hash persisted for this test's session, raw ID dropped.
    const sessions = await withPool((pool) =>
      pool.query(
        `SELECT anonymous_user_hash FROM telemetry_sessions
         WHERE project_id = $1 AND started_at >= $2`,
        [fixture.projectId, testStart],
      ),
    );
    expect(sessions.rows.length).toBeGreaterThan(0);
    for (const row of sessions.rows) {
      expect(String(row.anonymous_user_hash)).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});
