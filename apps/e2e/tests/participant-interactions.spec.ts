import { expect, test, type Page } from "@playwright/test";

const fixtureUrl = "/src/dev/interactionFixtures.html";

async function stopClock(page: Page, time = 1_700_000_000_000) {
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
}

test("review codes require an explicit request, including after a teammate mounts or remounts", async ({ page }, testInfo) => {
  await stopClock(page);
  await page.goto(`${fixtureUrl}?fixture=review`);
  const dashboard = page.getByRole("region", { name: "Your dashboard", exact: true });
  const requests = page.getByRole("status", { name: "Codes requested" });
  await expect(dashboard.getByRole("button", { name: "Show review code", exact: true })).toBeVisible();
  await expect(dashboard.getByText("Your panel is ready for you")).toBeVisible();
  await expect(dashboard.getByText("Head to Panel 3’s table.")).toBeVisible();
  await expect(dashboard.getByText("Bring your whole team.")).toBeVisible();
  await expect(requests).toHaveText("0");
  await dashboard.getByRole("button", { name: "Show review code", exact: true }).click();
  await expect(dashboard.getByRole("img", { name: "Team review code", exact: true })).toBeVisible();
  await expect(requests).toHaveText("1");
  for (let mount = 0; mount < 3; mount++) {
    await page.getByRole("button", { name: "Toggle teammate dashboard" }).click();
    await page.clock.runFor(1_000);
    await expect(requests).toHaveText("1");
    await expect(dashboard.getByText("CODE-1")).toBeVisible();
  }
  await dashboard.getByRole("button", { expanded: true }).click();
  await expect(dashboard.getByRole("img", { name: /as a blossom tree/ })).toBeVisible();
  await dashboard.getByRole("button", { expanded: false }).click();
  await expect(dashboard.getByRole("img", { name: "Team review code", exact: true })).toBeVisible();
  await expect(requests).toHaveText("1");
  await expect(dashboard.getByText("Head to Panel 3’s table.")).toBeVisible();
  await expect(dashboard.getByText("Bring your whole team.")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("review-code.png") });
});

test("the playing track can be flagged with an empty queue", async ({ page }) => {
  await page.goto(`${fixtureUrl}?fixture=music`);
  const playing = page.getByRole("region", { name: "Now playing", exact: true });
  await expect(page.getByText("Nothing queued yet.")).toBeVisible();
  await playing.getByRole("button", { name: "Flag Current track for the desk" }).click();
  await expect(playing.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await playing.getByRole("textbox", { name: "Reason", exact: true }).fill("  Inappropriate lyrics  ");
  await playing.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status", { name: "Reports recorded" })).toHaveText(
    JSON.stringify([{ id: "playing-track", reason: "Inappropriate lyrics" }]),
  );
  await expect(playing.getByText("flagged", { exact: true })).toBeVisible();
  await expect(playing.getByRole("button", { name: "Flag Current track for the desk" })).toHaveCount(0);
});

test("song reports preserve the reason after a failure and still work for queued songs", async ({ page }) => {
  await page.goto(`${fixtureUrl}?fixture=music&queued&failFirst`);
  const playing = page.getByRole("region", { name: "Now playing", exact: true });
  await playing.getByRole("button", { name: "Flag Current track for the desk" }).click();
  await playing.getByRole("textbox", { name: "Reason", exact: true }).fill("Inappropriate lyrics");
  await playing.getByRole("button", { name: "Send", exact: true }).click();
  await expect(playing.getByRole("alert")).toHaveText("Please try again.");
  await expect(playing.getByRole("textbox", { name: "Reason", exact: true })).toHaveValue("Inappropriate lyrics");
  await playing.getByRole("button", { name: "Send", exact: true }).click();
  await expect(playing.getByText("flagged", { exact: true })).toBeVisible();
  const queue = page.getByRole("region", { name: "Music queue", exact: true });
  await queue.getByRole("button", { name: "Flag Queued track for the desk" }).click();
  await queue.getByRole("textbox", { name: "Reason", exact: true }).fill("Unsuitable for the event");
  await queue.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("status", { name: "Reports recorded" })).toHaveText(JSON.stringify([
    { id: "playing-track", reason: "Inappropriate lyrics" },
    { id: "queued-track", reason: "Unsuitable for the event" },
  ]));
  await expect(queue.getByText("flagged", { exact: true })).toBeVisible();
});

test("suspended music actions do not expose report controls", async ({ page }) => {
  await page.goto(`${fixtureUrl}?fixture=music&queued&suspended`);
  await expect(page.getByRole("region", { name: "Now playing", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Flag .* for the desk$/ })).toHaveCount(0);
});

for (const offset of [-180_000, 180_000]) {
  test(`review code expiry uses the server lifetime with a ${offset / 1_000}s clock offset`, async ({ page }) => {
    await stopClock(page, 1_700_000_000_000 + offset);
    await page.goto(`${fixtureUrl}?fixture=review`);
    const dashboard = page.getByRole("region", { name: "Your dashboard", exact: true });
    await dashboard.getByRole("button", { name: "Show review code", exact: true }).click();
    await expect(dashboard.getByLabel("Review code expires in 120 seconds")).toBeVisible();
    await page.clock.runFor(1_000);
    await expect(dashboard.getByLabel("Review code expires in 119 seconds")).toBeVisible();
    await page.clock.fastForward(119_000);
    await expect(dashboard.getByText("The last one expired.")).toBeVisible();
    await expect(dashboard.getByRole("img")).toHaveCount(0);
    await dashboard.getByRole("button", { name: "Show review code", exact: true }).click();
    await expect(dashboard.getByText("CODE-2")).toBeVisible();
    await expect(dashboard.getByLabel("Review code expires in 120 seconds")).toBeVisible();
  });
}

test("a failed review-code request can be retried", async ({ page }) => {
  await page.goto(`${fixtureUrl}?fixture=review&failFirst`);
  const dashboard = page.getByRole("region", { name: "Your dashboard", exact: true });
  await dashboard.getByRole("button", { name: "Show review code", exact: true }).press("Enter");
  await expect(dashboard.getByText("Please try again.")).toBeVisible();
  await dashboard.getByRole("button", { expanded: false }).press("Enter");
  await expect(dashboard.getByText("CODE-2")).toBeVisible();
});

test("Pairs starts timing on the first card, excludes pauses, and resets between boards", async ({ page }) => {
  await stopClock(page);
  await page.goto(`${fixtureUrl}?fixture=memory`);
  const time = page.getByText("time", { exact: true }).locator("..");
  await page.clock.runFor(2_000);
  await expect(time).toHaveText("time00:00");
  await expect(page.getByRole("button", { name: "Pause", exact: true })).toBeDisabled();
  await page.getByRole("gridcell", { name: "Card 1, face down", exact: true }).click();
  await page.clock.runFor(2_000);
  await expect(time).toHaveText("time00:02");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.clock.runFor(5_000);
  await expect(time).toHaveText("time00:02");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.clock.runFor(1_000);
  await expect(time).toHaveText("time00:03");
  await page.getByRole("button", { name: "New game", exact: true }).click();
  await page.clock.runFor(2_000);
  await expect(time).toHaveText("time00:00");
  await page.getByRole("gridcell", { name: "Card 1, face down", exact: true }).click();
  await page.clock.runFor(1_000);
  await expect(time).toHaveText("time00:01");
});

test("restarting Pattern during its reveal gives the new board its full reveal time", async ({ page }) => {
  await stopClock(page);
  await page.goto(`${fixtureUrl}?fixture=pattern`);
  const squares = page.getByRole("grid", { name: "Memory squares" });
  await expect(squares.locator(".is-lit")).toHaveCount(3);
  await page.clock.runFor(1_300);
  await page.getByRole("button", { name: "New game", exact: true }).click();
  await page.clock.runFor(700);
  await expect(squares.locator(".is-lit")).toHaveCount(3);
  await expect(squares.getByRole("gridcell").first()).toBeDisabled();
  await page.clock.runFor(1_065);
  await expect(squares.locator(".is-lit")).toHaveCount(0);
  await expect(squares.getByRole("gridcell").first()).toBeEnabled();
});

test("Stack's P shortcut opens and closes its menu without restarting the round", async ({ page }) => {
  await stopClock(page);
  await page.goto(`${fixtureUrl}?fixture=stack`);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const starts = page.getByRole("status", { name: "Rounds started" });
  await expect(starts).toHaveText("1");
  await page.keyboard.press("p");
  const menu = page.getByRole("dialog", { name: "Game menu" });
  await expect(menu).toBeVisible();
  await expect(menu.getByText(/P opens menu/)).toBeVisible();
  await page.clock.runFor(1_000);
  await page.keyboard.press("Shift+P");
  await expect(menu).toHaveCount(0);
  await expect(starts).toHaveText("1");
  await expect(page.getByRole("button", { name: "Play", exact: true })).toHaveCount(0);
});

test.describe("Pac-Man touch controls", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("touch buttons steer Pac-Man and fit beside the playable board", async ({ page }, testInfo) => {
    await stopClock(page);
    await page.goto(`${fixtureUrl}?fixture=pacman`);
    const controls = page.getByRole("group", { name: "Movement controls" });
    await expect(controls).toBeVisible();
    await expect(controls.getByRole("button")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "Move right" })).toBeDisabled();
    await page.getByRole("button", { name: "Mute", exact: true }).tap();
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    const pacman = page.getByRole("img", { name: "Pac-Man", exact: true });
    const initial = await pacman.boundingBox();
    if (!initial) throw new Error("Pac-Man is missing");
    await page.getByRole("button", { name: "Move right" }).tap();
    await page.clock.runFor(250);
    const right = await pacman.boundingBox();
    expect(right?.x).toBeGreaterThan(initial.x);
    await page.getByRole("button", { name: "Move left" }).tap();
    await page.clock.runFor(150);
    const left = await pacman.boundingBox();
    if (!right || !left) throw new Error("Pac-Man is missing");
    expect(left.x).toBeLessThan(right.x);
    for (const region of [page.getByRole("img", { name: "Pac-Man maze" }), controls]) {
      const box = await region.boundingBox();
      if (!box) throw new Error("Required game region is missing");
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    }
    await page.screenshot({ path: testInfo.outputPath("pacman-touch.png") });
  });

  test("cancelling a held touch gives control back to a still-held keyboard direction", async ({ page }) => {
    await stopClock(page);
    await page.goto(`${fixtureUrl}?fixture=pacman`);
    await page.getByRole("button", { name: "Mute", exact: true }).tap();
    await page.getByRole("button", { name: "Play", exact: true }).tap();
    await page.keyboard.down("d");
    await page.clock.runFor(350);
    const pacman = page.getByRole("img", { name: "Pac-Man", exact: true });
    const right = await pacman.boundingBox();
    const button = await page.getByRole("button", { name: "Move left" }).boundingBox();
    if (!button || !right) throw new Error("Game controls are missing");
    const input = await page.context().newCDPSession(page);
    await input.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x: button.x + button.width / 2, y: button.y + button.height / 2 }],
    });
    await page.clock.runFor(300);
    const left = await pacman.boundingBox();
    if (!left) throw new Error("Pac-Man is missing");
    expect(left.x).toBeLessThan(right.x);
    await input.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    // Leave time for the buffered turn to expire and the held key to cross a tile.
    await page.clock.runFor(600);
    expect((await pacman.boundingBox())?.x).toBeGreaterThan(left.x);
    await page.keyboard.up("d");
    await input.detach();
  });
});
