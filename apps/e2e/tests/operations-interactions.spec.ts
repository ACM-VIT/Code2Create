import { expect, test } from "@playwright/test";

const fixtureUrl = "/src/dev/synesthesiaDecisions.html";

for (const width of [1440, 390]) {
  test(`selected team integrations search the full cohort and filter at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/src/dev/integrationOverview.html");
    const rows = page.locator(".integration-health-row");
    const search = page.getByRole("searchbox", { name: "Search selected teams" });
    await expect(rows).toHaveCount(30);
    await expect(page.getByRole("status")).toHaveText("Showing 30 of 42 matching selected teams");
    await search.fill("  selected TEAM 39  ");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Selected Team 39");
    await search.fill("sel41");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Selected Team 41");
    await expect(rows.first()).not.toContainText("missing the event topic");
    await expect(rows.first()).not.toContainText("only partly counted");
    await page.getByRole("combobox", { name: "Connection status" }).selectOption("disconnected");
    await expect(rows).toHaveCount(0);
    await expect(page.getByText("No selected teams match your search and connection filter.")).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(search).toHaveValue("");
    await expect(rows).toHaveCount(30);
    await page.getByRole("combobox", { name: "Connection status" }).selectOption("ready");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Selected Team 41");
    await expect(page.getByRole("status")).toHaveText("Showing 1 of 1 matching selected teams");
    await page.screenshot({ path: testInfo.outputPath(`selected-integrations-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Clear filters" }).click();
    await page.getByRole("button", { name: "Show more teams (12 remaining)" }).click();
    await expect(rows).toHaveCount(42);
    await expect(page.getByRole("button", { name: /Show more teams/ })).toHaveCount(0);
  });
}

test("selected team integrations keep search available in an empty workspace", async ({ page }) => {
  await page.goto("/src/dev/integrationOverview.html?empty");
  await expect(page.getByRole("searchbox", { name: "Search selected teams" })).toBeVisible();
  await expect(page.getByText("No selected teams are available in this workspace.")).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Showing 0 of 0 matching selected teams");
});

for (const width of [1440, 390]) {
  test(`queue-only operators can accept once without a form at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureUrl);
    await expect(page.getByText("Requested by Fixture Requester")).toBeVisible();
    await expect(page.getByRole("button", { name: /^(Hide|Start|Queue|Pin|Pause access)$/ })).toHaveCount(0);
    const accept = page.getByRole("button", { name: "Accept", exact: true });
    await accept.evaluate(button => {
      // Same-tick duplicate taps must not produce two commands before React rerenders.
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expect(page.getByRole("status")).toHaveText("approved; version 2; 1 transport calls");
    await expect(page.locator("form, textarea, input")).toHaveCount(0);
    await expect(accept).toHaveCount(0);
  });
}

test("queue-only operators can reject immediately without a reason form", async ({ page }) => {
  await page.goto(fixtureUrl);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("rejected; version 2; 1 transport calls");
  await expect(page.locator("form, textarea, input")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Accept|Reject)$/ })).toHaveCount(0);
});

for (const action of ["Accept", "Reject"]) {
  test(`${action} retries the original command after a saved decision loses its response`, async ({ page }) => {
    await page.goto(fixtureUrl);
    await page.getByRole("combobox", { name: "Transport scenario" }).selectOption("lost-response");
    await page.getByRole("button", { name: "Reset fixture" }).click();
    await page.getByRole("button", { name: action, exact: true }).click();
    const state = action === "Accept" ? "approved" : "rejected";
    await expect(page.getByRole("status")).toHaveText(`${state}; version 2; 1 transport calls`);
    await expect(page.getByRole("alert")).toHaveText("Fixture connection lost after the decision was saved.");
    if (action === "Accept") await expect(page.getByRole("button", { name: "Reject", exact: true })).toBeDisabled();
    const calls = page.getByLabel("Mutation calls");
    const firstText = await calls.textContent();
    if (firstText === null) throw new Error("Fixture calls are missing");
    const first: unknown = JSON.parse(firstText);
    if (!Array.isArray(first)) throw new Error("Fixture calls must be an array");
    await page.getByRole("button", { name: "Retry earlier decision", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(`${state}; version 2; 2 transport calls`);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry earlier decision", exact: true })).toHaveCount(0);
    const retriedText = await calls.textContent();
    if (retriedText === null) throw new Error("Fixture calls are missing");
    const retried: unknown = JSON.parse(retriedText);
    expect(retried).toEqual([first[0], first[0]]);
  });
}

test("a definite permission error stays on the card and releases the pending command", async ({ page }) => {
  await page.goto(fixtureUrl);
  await page.getByRole("combobox", { name: "Transport scenario" }).selectOption("permission-denied");
  await page.getByRole("button", { name: "Reset fixture" }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Fixture permission was revoked.");
  await expect(page.getByRole("status")).toHaveText("pending; version 1; 1 transport calls");
  await expect(page.getByRole("button", { name: "Retry earlier decision", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("rejected; version 2; 2 transport calls");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("outing capacity saves the configured maximum and preserves occupied permissions when reduced", async ({ page }, testInfo) => {
  await page.goto("/src/dev/outingCapacity.html");
  await page.getByRole("spinbutton", { name: "Maximum simultaneous outings" }).fill("10");
  await page.getByRole("button", { name: "Save outing capacity" }).click();
  await expect(page.getByRole("status")).toHaveText("15 of 10 slots occupied · 2 waiting");
  await expect(page.getByText(/Existing permissions remain valid/)).toBeVisible();
  const encoded = await page.getByLabel("Capacity commands").textContent();
  if (encoded === null) throw new Error("Missing capacity commands");
  const calls: unknown = JSON.parse(encoded);
  expect(calls).toHaveLength(1);
  expect(calls).toMatchObject([{ capacity: 10, expectedVersion: 1 }]);
  await page.getByRole("button", { name: "Can go", exact: true }).click();
  await expect(page.getByRole("button", { name: "Can go", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: testInfo.outputPath("outing-capacity.png") });
});

test("a lost outing capacity response retries the same command and cannot save a second edit", async ({ page }) => {
  await page.goto("/src/dev/outingCapacity.html?lost");
  const input = page.getByRole("spinbutton", { name: "Maximum simultaneous outings" });
  await input.fill("20");
  await page.getByRole("button", { name: "Save outing capacity" }).click();
  await expect(page.getByRole("alert")).toContainText("response was lost");
  await expect(input).toBeDisabled();
  await page.getByRole("button", { name: "Retry capacity change" }).click();
  await expect(input).toBeEnabled();
  const encoded = await page.getByLabel("Capacity commands").textContent();
  if (encoded === null) throw new Error("Missing capacity commands");
  const calls: unknown = JSON.parse(encoded);
  expect(calls).toHaveLength(2);
  if (!Array.isArray(calls)) throw new Error("Expected command array");
  const commands: readonly unknown[] = calls;
  expect(commands[0]).toEqual(commands[1]);
});
