import { expect, test, type Page } from "@playwright/test";

const fixtureUrl = "/src/dev/interactionFixtures.html?fixture=dashboard";

async function issueBenefit(page: Page) {
  await page.goto(fixtureUrl);
  await page.getByRole("button", { name: "Issue benefit", exact: true }).click();
}

for (const width of [1440, 390]) {
  test(`benefits replace Help and redeem with the real code at ${width}px`, async ({ page, context }, testInfo) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureUrl);
    await expect(page.getByText("help", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Issue benefit", exact: true }).click();
    await expect(page.getByText("help", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: /outing/i })).toBeVisible();
    const open = page.getByRole("button", { name: "Open Fixture credit", exact: true });
    await expect(page.getByText("TEST-CREDIT", { exact: true })).toHaveCount(0);
    await open.click();
    const dialog = page.getByRole("dialog", { name: "Fixture credit", exact: true });
    await expect(dialog).toBeVisible();
    // The suite defaults to reduced motion: no GPU/chest or forced delay.
    await expect(dialog.locator("[data-benefit-chest]")).toHaveCount(0);
    await expect(dialog.getByText("TEST-CREDIT", { exact: true })).toBeVisible();
    await expect(dialog.getByText("For your team", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "Redeem benefit" })).toHaveAttribute("href", "https://example.com/redeem");
    await expect(dialog.getByRole("link", { name: "Redeem benefit" })).toHaveAttribute("rel", "noopener noreferrer");
    await dialog.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("Code copied to clipboard.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("TEST-CREDIT");
    const fits = await dialog.evaluate(element => element.scrollWidth <= element.clientWidth);
    expect(fits).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`benefit-${width}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
    await page.getByRole("button", { name: "Remove benefits", exact: true }).click();
    await expect(page.getByText("benefits", { exact: true })).toHaveCount(0);
    await expect(page.getByText("help", { exact: true })).toBeVisible();
  });
}

test("benefit chest fallback completes and revealed grants do not replay", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => { Object.defineProperty(navigator, "gpu", { value: undefined }); });
  await issueBenefit(page);
  await page.getByRole("button", { name: "Open Fixture credit", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Fixture credit", exact: true });
  await expect(dialog.locator('[data-benefit-chest="css"]')).toBeVisible();
  await expect(dialog.getByText("TEST-CREDIT", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Back to benefits", exact: true }).click();
  await page.getByRole("button", { name: "Open Fixture credit", exact: true }).click();
  await expect(dialog.locator("[data-benefit-chest]")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Issue second benefit", exact: true }).click();
  await page.getByRole("button", { name: "Open Personal perk", exact: true }).click();
  const next = page.getByRole("dialog", { name: "Personal perk", exact: true });
  await expect(next.locator('[data-benefit-chest="css"]')).toBeVisible();
  await next.getByRole("button", { name: "Show code now", exact: true }).click();
  await expect(next.getByText("PERSONAL-CODE", { exact: true })).toBeVisible();
  await expect(next.getByText("Just for you", { exact: true })).toBeVisible();
  await expect(next.getByRole("link", { name: "Redeem benefit" })).toHaveCount(0);
});

test("a stalled GPU still reveals the benefit and closing early is safe", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", { value: { requestAdapter: () => new Promise(() => {}) } });
  });
  await issueBenefit(page);
  const open = page.getByRole("button", { name: "Open Fixture credit", exact: true });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Fixture credit", exact: true });
  await expect(dialog.locator('[data-benefit-chest="loading"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await open.click();
  await expect(dialog.locator('[data-benefit-chest="css"]')).toBeVisible();
  await expect(dialog.getByText("TEST-CREDIT", { exact: true })).toBeVisible();
});

test("keyboard activation skips celebration and clipboard failure keeps the code usable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("Clipboard blocked")) } });
  });
  await issueBenefit(page);
  await page.getByRole("button", { name: "Open Fixture credit", exact: true }).press("Enter");
  const dialog = page.getByRole("dialog", { name: "Fixture credit", exact: true });
  await expect(dialog.locator("[data-benefit-chest]")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Copy code", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Select the code above");
  await expect(dialog.getByText("TEST-CREDIT", { exact: true })).toBeVisible();
});

test("removing a live grant closes its reveal and restores Help", async ({ page }) => {
  await issueBenefit(page);
  await page.getByRole("button", { name: "Open Fixture credit", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Fixture credit", exact: true })).toBeVisible();
  // Drive the fixture's live model while the underlying UI is inert, as a query update would.
  await page.getByRole("button", { name: "Remove benefits", exact: true }).evaluate(button => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("TEST-CREDIT", { exact: true })).toHaveCount(0);
  await expect(page.getByText("help", { exact: true })).toBeVisible();
});
