import { expect, test, type Page } from "@playwright/test";

const SAFE_VALUE = "browser-compat-safe-value";

function trackRemoteRequests(page: Page): string[] {
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
      remoteRequests.push(request.url());
    }
  });
  return remoteRequests;
}

test.describe("SDK/demo browser compatibility smoke", () => {
  test("renders the demo and its SDK status without a host crash", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const remoteRequests = trackRemoteRequests(page);

    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "ReplayBug Demo App" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "SDK Status" }),
    ).toBeVisible();
    const telemetryStatus = page.locator("p").filter({ hasText: "Telemetry:" });
    await expect(telemetryStatus).toBeVisible();
    await expect(telemetryStatus).toContainText(
      /Telemetry:.*(Enabled|Disabled)/,
    );
    expect(pageErrors).toEqual([]);
    expect(remoteRequests).toEqual([]);
  });

  test("supports local navigation, clicks, and opt-in safe input", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const remoteRequests = trackRemoteRequests(page);

    await page.goto("/");
    await page.evaluate(() => {
      window.location.hash = "browser-compatibility";
    });
    await expect(page).toHaveURL(/#browser-compatibility$/);

    await page.getByRole("button", { name: "clearUser()" }).click();
    await expect(
      page.getByText("User cleared", { exact: false }),
    ).toBeVisible();

    const safeInput = page.getByTestId("repro-safe-input");
    await expect(safeInput).toHaveAttribute("data-replaybug-safe", "true");
    await safeInput.fill(SAFE_VALUE);
    await expect(safeInput).toHaveValue(SAFE_VALUE);
    await expect(page.locator('input[type="password"]')).toHaveAttribute(
      "type",
      "password",
    );

    expect(pageErrors).toEqual([]);
    expect(remoteRequests).toEqual([]);
  });
});
