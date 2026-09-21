import { expect, test } from "@playwright/test";
import {
  e2eFixture,
  persistedTelemetryJson,
  pollUntil,
  withPool,
} from "./helpers";

const fixture = e2eFixture();

const SAFE_FIXTURE = "SAFE_REPLAYBUG_VALUE";
const PASSWORD_FIXTURE = "ReplayBugPassword123!";
const CARD_FIXTURE = "4111111111111111";
const TOKEN_FIXTURE = "rb_demo_token_secret_value";
const MASKED_FIXTURE = "MASKED_REPLAYBUG_VALUE";
const IGNORED_FIXTURE = "IGNORED_REPLAYBUG_VALUE";
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
          `SELECT COUNT(*)::int AS count FROM events
           WHERE project_id = $1 AND received_at >= $2
             AND row_to_json(events)::text LIKE $3`,
          [fixture.projectId, testStart, `%${SAFE_FIXTURE}%`],
        );
        return res.rows[0].count > 0 ? true : null;
      });
    });

    // Zero occurrences for every sensitive fixture and the raw user ID
    // across ALL persisted telemetry for the project.
    const persisted = await persistedTelemetryJson(fixture.projectId);
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
        `SELECT COUNT(*)::int AS count FROM events
         WHERE project_id = $1
           AND row_to_json(events)::text LIKE $2
           AND (event_type <> 'input'
                OR payload_json->>'is_safe_selector_match' <> 'true')`,
        [fixture.projectId, `%${SAFE_FIXTURE}%`],
      ),
    );
    expect(wrongLocations.rows[0].count).toBe(0);

    const safeEvents = await withPool((pool) =>
      pool.query(
        `SELECT payload_json->>'value' AS value FROM events
         WHERE project_id = $1 AND received_at >= $2 AND event_type = 'input'
           AND payload_json->>'is_safe_selector_match' = 'true'`,
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
