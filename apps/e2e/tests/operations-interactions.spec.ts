import { expect, test } from "@playwright/test";

const fixtureUrl = "/src/dev/synesthesiaDecisions.html";

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
