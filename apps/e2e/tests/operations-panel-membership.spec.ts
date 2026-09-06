import { expect, test } from "@playwright/test";

for (const width of [390, 1440]) {
  test(`Board can select a reserve with different scoring skills at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/src/dev/reviewPanelMembership.html");
    await page.getByRole("button", { name: "Edit reviewers" }).click();
    await page.getByLabel("Current seat").selectOption("Tarun");
    await page.getByLabel("Find a replacement").fill("vian");
    await page.getByLabel("Replace with").selectOption("Vian Mangal");
    await expect(page.getByRole("status", { name: "Panel change warnings" })).toContainText("Not assessed for technical execution");
    await page.getByRole("combobox", { name: "Reason", exact: true }).selectOption("Reviewer availability changed");
    await expect(page.getByRole("button", { name: "Replace reviewer anyway" })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Replace reviewer anyway" }).click();
    await expect(page.getByLabel("Panel changes")).toContainText('"joiningPersonId":"Vian Mangal"');
    await expect(page.getByLabel("Panel changes")).toContainText('"leavingPersonId":"Tarun"');
  });
}

test("Board can swap different seniorities; busy candidates remain visibly unavailable", async ({ page }) => {
  await page.goto("/src/dev/reviewPanelMembership.html");
  await page.getByRole("button", { name: "Edit reviewers" }).click();
  await page.getByLabel("Current seat").selectOption("Tarun");
  const replacement = page.getByLabel("Replace with");
  await expect(replacement.locator('option[value="Busy reviewer"]')).toHaveAttribute("disabled", "");
  await expect(replacement.locator('option[value="Busy reviewer"]')).toContainText("Review in progress");
  await expect(replacement.locator('option[value="Paged reviewer"]')).toHaveAttribute("disabled", "");
  await replacement.selectOption("Junior reviewer");
  const warnings = page.getByRole("status", { name: "Panel change warnings" });
  await expect(warnings).toContainText("JC reviewer in a SC seat");
  await expect(warnings).toContainText("Panel 2: SC reviewer in a JC seat");
  await page.getByRole("combobox", { name: "Reason", exact: true }).selectOption("Reviewer availability changed");
  await page.getByRole("button", { name: "Swap reviewers anyway" }).click();
  await expect(page.getByLabel("Panel changes")).toContainText('"sourcePanel":{"panelId":"Panel 2","expectedVersion":1}');
});

test("SC cannot see panel editing controls", async ({ page }) => {
  await page.goto("/src/dev/reviewPanelMembership.html?role=sc");
  await expect(page.getByRole("heading", { name: "Panel 7" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit reviewers" })).toHaveCount(0);
  await expect(page.getByLabel("Panel changes")).toHaveText("[]");
});
