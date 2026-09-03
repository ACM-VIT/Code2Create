import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

const messagingService = readTemplate("PagerMessagingService.kt");
const alarmService = readTemplate("PagerAlarmService.kt");
const alarmPackage = readTemplate("PagerAlarmPackage.kt");
const pagerPlugin = readFileSync(
  new URL("../../plugins/withPagerService.js", import.meta.url),
  "utf8",
);

describe("Android pager native contract", () => {
  test("drops native pages while the live app owns the foreground alert", () => {
    expect(messagingService).toContain("PagerAlarmService.isAppForeground()");
    expect(messagingService).toContain("PagerAlarmService.stop(this)");
    expect(alarmService).toContain("if (isAppForeground())");
    expect(pagerPlugin).toContain("PagerAlarmService.setAppForeground(true)");
    expect(pagerPlugin).toContain("PagerAlarmService.setAppForeground(false)");
  });

  test("registers the JavaScript stop bridge in the generated application", () => {
    expect(pagerPlugin).toContain("add(PagerAlarmPackage())");
    expect(alarmPackage).toContain("class PagerAlarmPackage : BaseReactPackage()");
    expect(alarmPackage).toContain("PagerAlarmService.stop(reactApplicationContext)");
  });

  test("uses absolute expiry for delayed push delivery", () => {
    expect(messagingService).toContain("expiresAt <= System.currentTimeMillis()");
    expect(messagingService).toContain("PagerAlarmService.EXTRA_EXPIRES_AT, expiresAt");
    expect(messagingService).not.toContain("responseSeconds");
    expect(alarmService).toContain("expiresAt - System.currentTimeMillis()");
    expect(alarmService).toContain("remainingMs.coerceAtMost(MAX_RING_MS)");
  });
});

function readTemplate(name: string) {
  return readFileSync(new URL(`../../plugins/pager/${name}`, import.meta.url), "utf8");
}
