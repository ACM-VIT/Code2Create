import { describe, expect, test } from "vitest";
import * as v from "valibot";

import {
  autonomyReadEvidenceKeys,
  requiredAutonomyPageCitationGroups,
  type AutonomyReadReceipt,
} from "./autonomyExecution.ts";
import { operationsAutonomyReadReceiptSchema } from "./autonomyProtocol.ts";
import { investigationAreasForPage } from "./autonomyTraversal.ts";

const deepReadFixtures = [
  {
    read: "intake_jobs",
    area: "intake",
    data: {
      generatedAt: 9,
      jobs: [
        {
          jobId: "intake-job-9",
          state: "failed",
          policyVersionId: "intake-policy-2",
          ordinal: 9,
          createdAt: 1,
          failureClass: "failed",
        },
      ],
    },
    empty: { generatedAt: 9, jobs: [] },
    keys: ["intake-job-9", "failed", "intake-policy-2"],
  },
  {
    read: "admission_jobs",
    area: "admissions",
    data: {
      generatedAt: 9,
      jobs: [
        {
          jobId: "admission-job-9",
          state: "running",
          policyVersionId: "admission-policy-2",
          applicationContentVersion: 4,
          createdAt: 1,
        },
      ],
    },
    empty: { generatedAt: 9, jobs: [] },
    keys: ["admission-job-9", "running", "admission-policy-2"],
  },
  {
    read: "participant_deliveries",
    area: "communications",
    data: {
      generatedAt: 9,
      deliveries: [
        {
          deliveryId: "delivery-9",
          state: "retry_wait",
          templateKey: "offer",
          policyVersionId: "communications-policy-2",
          retryNumber: 2,
          attemptCount: 3,
          version: 7,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    },
    empty: { generatedAt: 9, deliveries: [] },
    keys: ["delivery-9", "retry_wait", "7"],
  },
  {
    read: "integration_jobs",
    area: "integrations",
    data: {
      generatedAt: 9,
      bindings: [
        {
          provider: "github",
          bindingId: "binding-9",
          state: "active",
          syncState: "ready",
          version: 5,
          syncRevision: 4,
          syncedRevision: 4,
          connectedAt: 1,
          updatedAt: 2,
          topicState: "present",
        },
      ],
    },
    empty: { generatedAt: 9, bindings: [] },
    keys: ["binding-9", "github", "active", "5"],
  },
  {
    read: "round_export_jobs",
    area: "scores",
    data: {
      generatedAt: 9,
      exports: [
        {
          exportId: "export-9",
          roundId: "round-9",
          state: "verified",
          revision: 3,
          formatVersion: 2,
          closingRoundVersion: 8,
          counts: {
            team: 1,
            result: 1,
            excluded: 0,
            withdrawn: 0,
            reviewSession: 1,
            scorecard: 1,
            scorecardVersion: 1,
            correctionCase: 0,
            manualReviewRecord: 0,
          },
          version: 6,
          requestedAt: 1,
          updatedAt: 2,
        },
      ],
    },
    empty: { generatedAt: 9, exports: [] },
    keys: ["export-9", "round-9", "verified", "6"],
  },
  {
    read: "synesthesia_operations",
    area: "synesthesia",
    data: {
      generatedAt: 9,
      operations: [
        {
          kind: "request",
          requestId: "request-9",
          windowId: "window-1",
          state: "queued",
          queueMode: "normal",
          openReportCount: 0,
          version: 4,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    },
    empty: { generatedAt: 9, operations: [] },
    keys: ["request-9", "request", "4"],
  },
  {
    read: "incident_readiness",
    area: "system",
    data: {
      generatedAt: 9,
      items: [
        {
          kind: "incident",
          incidentId: "incident-9",
          severity: "critical",
          affectedService: "review_backend",
          state: "monitoring",
          manualModeState: "approved",
          manualModeApprovalCount: 2,
          version: 5,
          openedAt: 1,
          updatedAt: 2,
        },
      ],
    },
    empty: { generatedAt: 9, items: [] },
    keys: ["incident-9", "incident", "monitoring", "5"],
  },
  {
    read: "attendance_operations",
    area: "attendance",
    data: {
      generatedAt: 9,
      operations: [
        {
          kind: "station",
          stationId: "station-9",
          status: "active",
          configurationVersion: 7,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    },
    empty: { generatedAt: 9, operations: [] },
    keys: ["station-9", "station", "active", "7"],
  },
] as const;

function receipt(read: string, data: object, isDone = true): AutonomyReadReceipt {
  const parsed = v.parse(operationsAutonomyReadReceiptSchema, {
    state: "accepted",
    sequence: 7,
    read,
    data,
    page: isDone
      ? { isDone: true, snapshot: "deep-snapshot" }
      : { isDone: false, cursor: "opaque-next-page", snapshot: "deep-snapshot" },
  });
  return { ...parsed, operationId: `read:${read}:later`, byteLength: 1_024 };
}

describe("autonomy deep read projections", () => {
  for (const fixture of deepReadFixtures) {
    test(`${fixture.read} is strict, complete, and routed to ${fixture.area}`, () => {
      const laterPage = receipt(fixture.read, fixture.data);
      expect(requiredAutonomyPageCitationGroups(laterPage)).toEqual([fixture.keys]);
      expect(investigationAreasForPage(laterPage)).toEqual([fixture.area]);
      const evidenceKeys = autonomyReadEvidenceKeys(laterPage);
      for (const key of fixture.keys) expect(evidenceKeys.has(key)).toBe(true);

      const emptyPage = receipt(fixture.read, fixture.empty);
      expect(requiredAutonomyPageCitationGroups(emptyPage)).toEqual([]);
      expect(investigationAreasForPage(emptyPage)).toEqual([fixture.area]);

      expect(
        v.safeParse(operationsAutonomyReadReceiptSchema, {
          state: "accepted",
          sequence: 7,
          read: fixture.read,
          data: { ...fixture.data, rawProviderError: "PRIVATE_SENTINEL" },
          page: { isDone: true, snapshot: "deep-snapshot" },
        }).success,
      ).toBe(false);
    });
  }

  test("rejects a fifth row instead of silently widening a technical page", () => {
    const first = deepReadFixtures[0];
    const row = first.data.jobs[0];
    expect(
      v.safeParse(operationsAutonomyReadReceiptSchema, {
        state: "accepted",
        sequence: 1,
        read: first.read,
        data: { generatedAt: 1, jobs: [row, row, row, row, row] },
        page: { isDone: true, snapshot: "snapshot" },
      }).success,
    ).toBe(false);
  });
});
