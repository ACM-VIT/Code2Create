import { afterEach, describe, expect, test, vi } from "vitest";

import { attendanceQrPayload } from "@code2create/domain";

import {
  createAppleWalletDownloadToken,
  externalEventPassReference,
  formattedEventStart,
  verifyAppleWalletDownloadToken,
  type ExternalEventPassDetails,
} from "./externalEventPassWallet";

const details: ExternalEventPassDetails = {
  passId: "external-pass-id",
  payload: attendanceQrPayload({ kind: "external_pass", bearer: "a".repeat(43) }),
  eventName: "Code2Create 7.0",
  eventStartsAt: Date.UTC(2027, 7, 8, 3, 30, 0),
  eventEndsAt: Date.UTC(2027, 7, 9, 12, 30, 0),
  eventTimezone: "Asia/Kolkata",
  venueName: "VIT Vellore",
  participantName: "External Participant",
  teamName: "Static Pass",
};

afterEach(() => vi.unstubAllEnvs());

describe("external event-pass wallet helpers", () => {
  test("creates a signed Apple Wallet download token for one pass", async () => {
    vi.stubEnv("WALLET_DOWNLOAD_SIGNING_SECRET", "fixture-wallet-signing-secret-32-bytes");
    const token = await createAppleWalletDownloadToken(details);
    await expect(verifyAppleWalletDownloadToken(token)).resolves.toBe(details.passId);
  });

  test("rejects a wallet download token under another signing key", async () => {
    vi.stubEnv("WALLET_DOWNLOAD_SIGNING_SECRET", "fixture-wallet-signing-secret-32-bytes");
    const token = await createAppleWalletDownloadToken(details);
    vi.stubEnv("WALLET_DOWNLOAD_SIGNING_SECRET", "different-wallet-signing-secret-value");
    await expect(verifyAppleWalletDownloadToken(token)).rejects.toThrow();
  });

  test("formats the pass reference and local event time", () => {
    expect(externalEventPassReference(details.payload)).toBe("C2C-AAAA-AAAA");
    expect(formattedEventStart(details)).toContain("9:00");
  });
});
