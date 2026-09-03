import { expect, test } from "@playwright/test";

test("operations dashboard requires the assigned Google account", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Operations" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});
