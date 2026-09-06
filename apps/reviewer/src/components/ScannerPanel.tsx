import { outingReceiptMessage } from "../lib/outing-receipt";
import {
  attendanceMovementReasonLabels,
  attendanceMovementReasons,
  type AttendanceMovementReason,
  barcodeSymbologies,
  findBarcodeSymbology,
  parseAttendanceQrPayload,
  type AttendanceQr,
  type BarcodeSymbology,
} from "@code2create/domain";
import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useAction, usePaginatedQuery, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { randomUUID } from "expo-crypto";
import * as Network from "expo-network";
import {
  CameraView,
  type BarcodeScanningResult,
  type BarcodeType,
} from "expo-camera";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";

import { DutyIcon } from "@/components/DutyIcon";
import { useCameraAccess } from "@/lib/use-camera-access";
import {
  AppState,
  Dimensions,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  Action,
  Body,
  ChipRow,
  Field,
  Heading,
  HeaderButton,
  Meta,
  Nothing,
  Problem,
  QuietAction,
  Row,
  ScanSurface,
  type ScanVerdict,
  Section,
  Sheet,
} from "@/components/ui";
import {
  clearScannerDevice,
  createScannerDevice,
  loadScannerDevice,
  reserveDeviceSequence,
  type ScannerDeviceRecord,
  type ScannerPlatform,
} from "@/lib/scanner-device";
import {
  clearPendingAttendanceScans,
  enqueuePendingAttendanceScan,
  loadPendingAttendanceScans,
  pendingAttendanceSummary,
  removePendingAttendanceScan,
  type PendingAttendanceSummary,
} from "@/lib/pending-attendance-scans";
import {
  allowedRovingTransitions,
  physicalCardKind,
  stationAcceptsCredential,
  type ScanTransition,
} from "@/lib/attendance-station-policy";
import { describeError, OperatorError } from "@/lib/errors";
import {
  runPersistentClientOperation,
  usePersistentClientOperations,
} from "@/lib/client-operation-intents";
import { palette, radius } from "@/theme";
import { CaseListSkeleton, DoorSkeleton } from "@/components/skeletons";

type ScannerAssignment = NonNullable<FunctionReturnType<typeof api.attendanceScanner.current>>;
type ScanReceipt = FunctionReturnType<typeof api.attendanceActions.recordScan>;
type StaffedParticipant = FunctionReturnType<
  typeof api.attendanceActions.resolveExternalPass
>;
type CredentialId = FunctionReturnType<
  typeof api.attendanceActions.beginVitBarcodeEnrollment
>["credentialId"];
type VenueCheckInReceipt =
  | FunctionReturnType<typeof api.attendanceActions.recordVenueCheckIn>
  | FunctionReturnType<typeof api.attendanceActions.reverseVenueCheckIn>;
type ActiveVenueCheckInView = {
  id: FunctionReturnType<typeof api.attendanceActions.recordVenueCheckIn>["checkInId"];
  version: number;
  checkedInAt: number;
  stationName?: string;
};
type ScanCredential =
  | AttendanceQr
  | { kind: "vit_id_barcode" | "external_id_barcode"; rawBarcodeValue: string; symbology: BarcodeSymbology };
type DeviceReceipt = ScannerAssignment["recentReceipts"][number];
type DeviceState =
  | { status: "loading" }
  | { status: "ready"; record: ScannerDeviceRecord | null }
  | { status: "error"; message: string };
type ScannerTask = "presence" | "staffed";
type ManualLookupKind = "vit_registration" | "external_email";
const staffedOperationSlots = [
  "attendance.badge.begin",
  "attendance.badge.revoke",
  "attendance.badge.verify",
  "attendance.external-id.link",
  "attendance.external-pass.reissue",
  "attendance.external-pass.suspend",
  "attendance.venue.check-in",
  "attendance.venue.reverse",
  "attendance.vit.begin",
  "attendance.vit.suspend",
  "attendance.vit.verify",
] as const;
type HeartbeatState =
  | { status: "checking" }
  | { status: "online" }
  | { status: "error"; message: string };
type ServerClock = { serverNow: number; observedAt: number | null };
type CredentialSetupState =
  | { step: "participant" }
  | {
      step: "identity";
      participant: StaffedParticipant;
      resolutionSource: "vit_barcode" | "external_pass" | "external_id" | "manual";
    }
  | { step: "first_scan"; participant: StaffedParticipant }
  | {
      step: "second_scan_ready";
      participant: StaffedParticipant;
      credentialId: CredentialId;
      badgeReference: string | null;
    }
  | {
      step: "second_scan";
      participant: StaffedParticipant;
      credentialId: CredentialId;
      badgeReference: string | null;
    }
  | {
      step: "complete";
      participant: StaffedParticipant;
      outcome:
        | "vit_enrolled"
        | "external_id_linked"
        | "vit_replaced"
        | "vit_suspended"
        | "badge_issued"
        | "badge_replaced"
        | "badge_revoked"
        | "external_pass_reissued"
        | "external_pass_suspended";
    };

function currentServerNow(clock: ServerClock) {
  return clock.observedAt === null
    ? clock.serverNow
    : clock.serverNow + performance.now() - clock.observedAt;
}

function SetupFrame({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      contentContainerStyle={styles.setupFrame}
      contentInsetAdjustmentBehavior="automatic"
    >
      {children}
    </ScrollView>
  );
}

export function ScannerPanel({ eventSlug }: { eventSlug: string }) {
  const staffedOperations = usePersistentClientOperations(eventSlug, staffedOperationSlots);
  const platform = scannerPlatform();
  const [deviceState, setDeviceState] = useState<DeviceState>(() =>
    platform ? { status: "loading" } : { status: "ready", record: null },
  );
  const [registrationBusy, setRegistrationBusy] = useState(false);
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const current = useQuery(
    api.attendanceScanner.current,
    deviceState.status === "ready" && deviceState.record
      ? { eventSlug, installationId: deviceState.record.installationId }
      : "skip",
  );
  const registerDevice = useAction(api.attendanceActions.registerDevice);

  useEffect(() => {
    if (!platform) return;
    let active = true;
    void loadScannerDevice(eventSlug)
      .then((record) => {
        if (active) setDeviceState({ status: "ready", record });
      })
      .catch(() => {
        if (active) {
          setDeviceState({
            status: "error",
            message: "This phone cannot read its saved scanner setup.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [eventSlug, platform]);

  if (!platform) {
    return (
      <SetupFrame>
        <Section title="Attendance scanner">
          <Body>Open this duty on a provisioned Android phone or iPhone.</Body>
        </Section>
      </SetupFrame>
    );
  }
  if (deviceState.status === "loading") {
    return <DoorSkeleton />;
  }
  if (deviceState.status === "error") {
    const clearBrokenSetup = async () => {
      if (registrationBusy) return;
      setRegistrationBusy(true);
      setRegistrationError(null);
      try {
        await clearScannerDevice(eventSlug);
        setDeviceState({ status: "ready", record: null });
      } catch {
        setRegistrationError(
          "This phone could not clear its saved setup. Reinstall the reviewer app.",
        );
      } finally {
        setRegistrationBusy(false);
      }
    };
    return (
      <SetupFrame>
        <Section title="Scanner setup needs attention">
          <Problem>{deviceState.message}</Problem>
          <Action
            accent={palette.door}
            disabled={registrationBusy}
            label={registrationBusy ? "Resetting…" : "Reset scanner setup"}
            onPress={clearBrokenSetup}
          />
          {registrationError ? <Problem>{registrationError}</Problem> : null}
        </Section>
      </SetupFrame>
    );
  }

  const register = async (record: ScannerDeviceRecord) => {
    setRegistrationBusy(true);
    setRegistrationError(null);
    try {
      await registerDevice({
        eventSlug,
        installationId: record.installationId,
        deviceSecret: record.deviceSecret,
        name: record.deviceName,
        platform: record.platform,
        reason: "Enabled by the signed-in scanner operator",
        clientOperationId: record.registrationOperationId,
      });
    } catch (error) {
      setRegistrationError(errorMessage(error, "This phone could not be assigned."));
    } finally {
      setRegistrationBusy(false);
    }
  };

  const provision = async () => {
    setRegistrationBusy(true);
    setRegistrationError(null);
    try {
      const record = await createScannerDevice({
        eventSlug,
        platform,
      });
      setDeviceState({ status: "ready", record });
      await register(record);
    } catch (error) {
      setRegistrationError(errorMessage(error, "Scanner setup could not be saved."));
      setRegistrationBusy(false);
    }
  };

  if (!deviceState.record) {
    return (
      <SetupFrame>
        <Section title="Attendance scanner">
          {staffedOperations.records.size > 0 || staffedOperations.error ? (
            <Problem>
              {staffedOperations.error ??
                "Finish the saved credential action before assigning this phone again."}
            </Problem>
          ) : null}
          <Action
            accent={palette.door}
            disabled={
              registrationBusy ||
              staffedOperations.loading ||
              staffedOperations.error !== null ||
              staffedOperations.records.size > 0
            }
            label={registrationBusy ? "Starting…" : "Start scanning"}
            onPress={() => void provision()}
          />
          {registrationError ? <Problem>{registrationError}</Problem> : null}
        </Section>
      </SetupFrame>
    );
  }
  const deviceRecord = deviceState.record;
  if (current === undefined || (!current && registrationBusy)) {
    return <DoorSkeleton />;
  }
  if (!current) {
    const clearOldSetup = async () => {
      setRegistrationBusy(true);
      setRegistrationError(null);
      try {
        await clearPendingAttendanceScans({
          eventSlug,
          installationId: deviceRecord.installationId,
        });
        await clearScannerDevice(eventSlug);
        setDeviceState({ status: "ready", record: null });
      } catch (error) {
        setRegistrationError(errorMessage(error, "The old scanner setup could not be cleared."));
      } finally {
        setRegistrationBusy(false);
      }
    };
    return (
      <SetupFrame>
        <Section title="Scanner setup is not active">
          <Body>The saved scanner access is no longer active.</Body>
          {staffedOperations.records.size > 0 || staffedOperations.error ? (
            <Problem>
              {staffedOperations.error ??
                "Finish the saved credential action before changing this phone setup."}
            </Problem>
          ) : null}
          <Action
            accent={palette.door}
            disabled={registrationBusy || staffedOperations.loading}
            label={registrationBusy ? "Starting…" : "Reconnect scanner"}
            onPress={() => void register(deviceRecord)}
          />
          <QuietAction
            disabled={registrationBusy || staffedOperations.loading}
            label="Reset scanner"
            onPress={clearOldSetup}
          />
          {registrationError ? <Problem>{registrationError}</Problem> : null}
        </Section>
      </SetupFrame>
    );
  }

  return (
    <ScannerSurface
      assignment={current}
      deviceRecord={deviceRecord}
      eventSlug={eventSlug}
      onDeviceRecord={(record) => setDeviceState({ status: "ready", record })}
    />
  );
}

function ScannerSurface({
  assignment,
  deviceRecord,
  eventSlug,
  onDeviceRecord,
}: {
  assignment: ScannerAssignment;
  deviceRecord: ScannerDeviceRecord;
  eventSlug: string;
  onDeviceRecord: (record: ScannerDeviceRecord) => void;
}) {
  const staffedOperations = usePersistentClientOperations(eventSlug, staffedOperationSlots);
  const { permission, requestPermission, error: cameraAccessError, refresh: refreshCameraAccess } = useCameraAccess();
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraFocused, setCameraFocused] = useState(false);
  useFocusEffect(useCallback(() => {
    setCameraFocused(true);
    return () => setCameraFocused(false);
  }, []));
  const recordScan = useAction(api.attendanceActions.recordScan);
  const scannerHeartbeat = useAction(api.attendanceActions.scannerHeartbeat);
  const resolveExternalPass = useAction(api.attendanceActions.resolveExternalPass);
  const resolveVitBarcode = useAction(api.attendanceActions.resolveVitBarcode);
  const resolveExternalIdBarcode = useAction(api.attendanceActions.resolveExternalIdBarcode);
  const resolveManualParticipant = useAction(api.attendanceActions.resolveManualParticipant);
  const linkResolvedExternalIdBarcode = useAction(
    api.attendanceActions.linkResolvedExternalIdBarcode,
  );
  const beginVitBarcodeEnrollment = useAction(api.attendanceActions.beginVitBarcodeEnrollment);
  const enrolResolvedVitBarcode = useAction(api.attendanceActions.enrolResolvedVitBarcode);
  const verifyVitBarcodeEnrollment = useAction(api.attendanceActions.verifyVitBarcodeEnrollment);
  const beginVitBarcodeRebind = useAction(api.attendanceActions.beginVitBarcodeRebind);
  const verifyVitBarcodeRebind = useAction(api.attendanceActions.verifyVitBarcodeRebind);
  const suspendVitBarcode = useAction(api.attendanceActions.suspendVitBarcode);
  const suspendExternalPass = useAction(api.attendanceActions.suspendExternalPass);
  const reissueExternalPass = useAction(api.attendanceActions.reissueExternalPass);
  const beginExternalBadgeIssue = useAction(api.attendanceActions.beginExternalBadgeIssue);
  const verifyExternalBadgeIssue = useAction(api.attendanceActions.verifyExternalBadgeIssue);
  const beginExternalBadgeReplacement = useAction(
    api.attendanceActions.beginExternalBadgeReplacement,
  );
  const verifyExternalBadgeReplacement = useAction(
    api.attendanceActions.verifyExternalBadgeReplacement,
  );
  const revokeExternalBadge = useAction(api.attendanceActions.revokeExternalBadge);
  const recordVenueCheckIn = useAction(api.attendanceActions.recordVenueCheckIn);
  const reverseVenueCheckIn = useAction(api.attendanceActions.reverseVenueCheckIn);
  const networkState = Network.useNetworkState();
  const busyRef = useRef(false);
  const replayingRef = useRef(false);
  const serverClockRef = useRef<ServerClock>({
    serverNow: assignment.serverNow,
    observedAt: null,
  });
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const requestedTask = useLocalSearchParams<{ task?: string }>().task;
  const [venueDirection, setVenueDirection] = useState<"venue_entry" | "venue_exit">("venue_entry");
  const [movementReason, setMovementReason] = useState<AttendanceMovementReason | null>(
    assignment.station.mode === "venue_exit" || assignment.station.mode === "zone_exit" ? null : "general",
  );
  const [reasonPickerOpen, setReasonPickerOpen] = useState(false);
  const venueScanner = assignment.station.mode === "roving" && !assignment.station.sessionId;
  const departureSelected = venueScanner ? venueDirection === "venue_exit"
    : assignment.station.mode === "venue_exit" || assignment.station.mode === "zone_exit";
  const washroomQueue = useQuery(api.serviceQueues.forStation,
    venueScanner && departureSelected && movementReason === "short_break"
      ? { eventSlug, stationId: assignment.station.id } : "skip");
  const [chosenTask, setChosenTask] = useState<ScannerTask | null>(null);
  const task: ScannerTask | null =
    requestedTask === "staffed" || requestedTask === "presence" ? requestedTask : chosenTask;
  const [credentialSetup, setCredentialSetup] = useState<CredentialSetupState>({
    step: "participant",
  });
  const [credentialReason, setCredentialReason] = useState("");
  const [venueReason, setVenueReason] = useState("");
  const [venueCheckInReceipt, setVenueCheckInReceipt] = useState<VenueCheckInReceipt | null>(null);
  const [receipt, setReceipt] = useState<ScanReceipt | null>(null);
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null);
  const [pendingSummary, setPendingSummary] = useState<PendingAttendanceSummary>(() =>
    assignment.device.pendingReplayCount > 0 && assignment.device.oldestPendingCapturedAt
      ? {
          count: assignment.device.pendingReplayCount,
          oldestCapturedAt: assignment.device.oldestPendingCapturedAt,
        }
      : { count: 0 },
  );
  const [replayStatus, setReplayStatus] = useState<string | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [heartbeatState, setHeartbeatState] = useState<HeartbeatState>({
    status: "checking",
  });
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === "active");
  const [pendingScan, setPendingScan] = useState<ScanCredential | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [manualLookupOpen, setManualLookupOpen] = useState(false);
  const [manualLookupKind, setManualLookupKind] =
    useState<ManualLookupKind>("vit_registration");
  const [manualLookupValue, setManualLookupValue] = useState("");
  const staffedRecoveryLocked =
    staffedOperations.loading ||
    staffedOperations.error !== null ||
    staffedOperations.records.size > 0;
  const presenceWorkflowBlocker = staffedOperations.loading
    ? "Checking this phone for unfinished first check-ins…"
    : staffedOperations.error
      ? staffedOperations.error
      : staffedOperations.records.size > 0
        ? "Finish the saved first check-in before recording another movement."
        : null;
  const deviceHistory = usePaginatedQuery(
    api.attendanceScanner.history,
    { eventSlug, installationId: deviceRecord.installationId },
    { initialNumItems: 25 },
  );
  const barcodeTypes = useMemo(() => scannerBarcodeTypes(), []);
  const rovingTransitions = allowedRovingTransitions({
    ...assignment.station,
    ...(assignment.openSession ? { openSessionId: assignment.openSession.id } : {}),
  });
  const definitelyOffline =
    networkState.isConnected === false || networkState.isInternetReachable === false;
  const latestReplayReceipt = assignment.recentReceipts.find(
    (candidate) => candidate.isOfflineReplay,
  );

  useEffect(() => {
    serverClockRef.current = {
      serverNow: assignment.serverNow,
      observedAt: performance.now(),
    };
  }, [assignment.serverNow]);

  const refreshPendingSummary = useCallback(async () => {
    const summary = await pendingAttendanceSummary({
      eventSlug,
      installationId: deviceRecord.installationId,
      now: currentServerNow(serverClockRef.current),
    });
    setPendingSummary(summary);
    return summary;
  }, [deviceRecord.installationId, eventSlug]);

  const replayPending = useCallback(async () => {
    if (replayingRef.current || busyRef.current) return;
    replayingRef.current = true;
    setReplaying(true);
    setReplayStatus(null);
    let synced = 0;
    let rejected = 0;
    try {
      const pending = await loadPendingAttendanceScans({
        eventSlug,
        installationId: deviceRecord.installationId,
        now: currentServerNow(serverClockRef.current),
      });
      for (const operation of pending) {
        if (operation.stationStableKey !== assignment.station.stableKey) {
          await removePendingAttendanceScan({
            eventSlug,
            installationId: deviceRecord.installationId,
            deviceSequence: operation.deviceSequence,
          });
          rejected += 1;
          continue;
        }
        try {
          await recordScan({
            eventSlug,
            stationId: assignment.station.id,
            expectedConfigurationVersion: operation.expectedConfigurationVersion,
            deviceInstallationId: assignment.device.id,
            deviceSecret: deviceRecord.deviceSecret,
            credential: operation.credential,
            ...(operation.movementReason ? { movementReason: operation.movementReason } : {}),
            ...(operation.rovingTransition !== undefined
              ? { rovingTransition: operation.rovingTransition }
              : {}),
            clientOperationId: operation.clientOperationId,
            deviceSequence: operation.deviceSequence,
            capturedAt: operation.capturedAt,
            isOfflineReplay: true,
          });
          await removePendingAttendanceScan({
            eventSlug,
            installationId: deviceRecord.installationId,
            deviceSequence: operation.deviceSequence,
          });
          synced += 1;
        } catch (error) {
          if (!(error instanceof ConvexError)) {
            setHeartbeatState({
              status: "error",
              message: "Pending scans are still waiting to sync.",
            });
            break;
          }
          await removePendingAttendanceScan({
            eventSlug,
            installationId: deviceRecord.installationId,
            deviceSequence: operation.deviceSequence,
          });
          rejected += 1;
        }
      }
      const summary = await refreshPendingSummary();
      if (synced > 0 || rejected > 0) {
        setReplayStatus(
          [
            synced > 0 ? `${synced} pending ${synced === 1 ? "scan" : "scans"} synced` : null,
            rejected > 0
              ? `${rejected} ${rejected === 1 ? "scan needs" : "scans need"} staff follow-up`
              : null,
            summary.count > 0 ? `${summary.count} still waiting on this phone` : null,
          ]
            .filter((part) => part !== null)
            .join(" · "),
        );
      }
    } catch (error) {
      setReplayStatus(errorMessage(error, "The pending queue could not be opened."));
    } finally {
      replayingRef.current = false;
      setReplaying(false);
    }
  }, [
    assignment.device.id,
    assignment.station.id,
    assignment.station.stableKey,
    deviceRecord.deviceSecret,
    deviceRecord.installationId,
    eventSlug,
    recordScan,
    refreshPendingSummary,
  ]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      setAppIsActive(state === "active");
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const subscription = Network.addNetworkStateListener((state) => {
      const canReachServer = state.isConnected === true && state.isInternetReachable !== false;
      if (appIsActive && canReachServer) void replayPending();
    });
    return () => subscription.remove();
  }, [appIsActive, replayPending]);

  useEffect(() => {
    if (!permission?.granted || !appIsActive) return;
    let active = true;
    let requestInFlight = false;

    const heartbeat = async () => {
      if (requestInFlight) return;
      requestInFlight = true;
      try {
        const summary = await refreshPendingSummary();
        const result = await scannerHeartbeat({
          eventSlug,
          stationId: assignment.station.id,
          expectedConfigurationVersion: assignment.station.configurationVersion,
          deviceInstallationId: assignment.device.id,
          deviceSecret: deviceRecord.deviceSecret,
          pendingReplayCount: summary.count,
          ...(summary.oldestCapturedAt !== undefined
            ? { oldestPendingCapturedAt: summary.oldestCapturedAt }
            : {}),
        });
        serverClockRef.current = {
          serverNow: result.serverNow,
          observedAt: performance.now(),
        };
        if (active) {
          setHeartbeatState({ status: "online" });
          if (summary.count > 0) void replayPending();
        }
      } catch (error) {
        if (active) {
          setHeartbeatState({
            status: "error",
            message: errorMessage(error, "Scanner sync failed."),
          });
        }
      } finally {
        requestInFlight = false;
      }
    };

    void heartbeat();
    const interval = setInterval(() => void heartbeat(), 45_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [
    assignment.device.id,
    assignment.station.configurationVersion,
    assignment.station.id,
    appIsActive,
    deviceRecord.deviceSecret,
    eventSlug,
    permission?.granted,
    refreshPendingSummary,
    replayPending,
    scannerHeartbeat,
  ]);
  const displayedHeartbeatState: HeartbeatState =
    permission?.granted && appIsActive ? heartbeatState : { status: "checking" };

  const handleBarcode = async (scan: BarcodeScanningResult) => {
    if (!cameraFocused || !appIsActive || manualLookupOpen || historyOpen || busyRef.current || replayingRef.current || receipt || pendingConfirmation) return;
    busyRef.current = true;
    setBusy(true);
    setScanError(null);
    try {
      if (task === "staffed") {
        await handleCredentialBarcode(scan);
      } else {
        await handlePresenceBarcode(scan);
      }
    } catch (error) {
      setScanError(
        errorMessage(
          error,
          task === "staffed"
            ? "The staffed participant flow could not continue."
            : "The scan could not be recorded.",
        ),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleManualLookup = async () => {
    if (busyRef.current || manualLookupValue.trim().length === 0) return;
    busyRef.current = true;
    setBusy(true);
    setScanError(null);
    try {
      const participant = await resolveManualParticipant({
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        lookup: { kind: manualLookupKind, value: manualLookupValue },
      });
      setVenueReason("");
      setVenueCheckInReceipt(null);
      setCredentialSetup({ step: "identity", participant, resolutionSource: "manual" });
      setManualLookupOpen(false);
      setManualLookupValue("");
    } catch (error) {
      setScanError(errorMessage(error, "The participant could not be found."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handlePresenceBarcode = async (scan: BarcodeScanningResult) => {
    const parsedAttendanceQr = parseAttendanceQrPayload(scan.data);
    const symbology = findBarcodeSymbology(scan.type);
    const vitSymbology = parsedAttendanceQr ? null : allowedVitBarcode(symbology, assignment);
    const credential: ScanCredential | null =
      parsedAttendanceQr ??
      (vitSymbology
        ? { kind: physicalCardKind(scan.data), rawBarcodeValue: scan.data, symbology: vitSymbology }
        : null);
    if (!credential) {
      throw new OperatorError(unreadableCredential(symbology, assignment));
    }
    if (!stationAcceptsCredential(assignment.station.allowedCredentialKinds, credential.kind)) {
      throw new OperatorError(
        `${credentialName(credential.kind)} cannot be used for this scan.`,
      );
    }
    if (venueScanner) {
      await sendPresenceScan(credential, venueDirection);
    } else {
      setPendingScan(credential);
    }
  };

  const submitPendingScan = async (rovingTransition: ScanTransition | undefined) => {
    if (!pendingScan || busyRef.current || replayingRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setScanError(null);
    try { await sendPresenceScan(pendingScan, rovingTransition); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const sendPresenceScan = async (credential: ScanCredential, rovingTransition: ScanTransition | undefined) => {
    try {
      const transition = assignment.station.mode === "roving" ? rovingTransition : assignment.station.mode;
      if (movementReason === null || (movementReason === "general" && (transition === "venue_exit" || transition === "zone_exit"))) {
        throw new OperatorError("Choose why they are leaving, then scan their ID.");
      }
      if (definitelyOffline && movementReason === "short_break" && (transition === "venue_exit" || transition === "zone_exit")) {
        throw new OperatorError("Connect to the internet to check short-break permission before departure.");
      }
      const reserved = await reserveDeviceSequence({
        eventSlug,
        record: deviceRecord,
        serverSequence: assignment.device.lastSequence,
      });
      onDeviceRecord(reserved);
      const capturedAt = Math.round(currentServerNow(serverClockRef.current));
      const clientOperationId = randomUUID();
      const queuedOperation = {
        eventSlug,
        installationId: reserved.installationId,
        stationStableKey: assignment.station.stableKey,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        credential,
        movementReason,
        ...(rovingTransition !== undefined ? { rovingTransition } : {}),
        clientOperationId,
        deviceSequence: reserved.lastIssuedSequence,
        capturedAt,
      };
      await enqueuePendingAttendanceScan({
        input: queuedOperation,
        maxScans: assignment.offlinePolicy.maxScans,
        maxAgeSeconds: assignment.offlinePolicy.maxAgeSeconds,
        now: capturedAt,
      });
      await refreshPendingSummary();
      if (definitelyOffline) {
        setPendingConfirmation(
          "Saved on this phone. It is pending—not accepted—and will sync when the connection returns.",
        );
        return;
      }
      let result: ScanReceipt;
      try {
        result = await recordScan({
          eventSlug,
          stationId: assignment.station.id,
          expectedConfigurationVersion: assignment.station.configurationVersion,
          deviceInstallationId: assignment.device.id,
          deviceSecret: reserved.deviceSecret,
          credential,
          movementReason,
          ...(rovingTransition !== undefined ? { rovingTransition } : {}),
          clientOperationId,
          deviceSequence: reserved.lastIssuedSequence,
          capturedAt,
          isOfflineReplay: false,
        });
      } catch (error) {
        if (error instanceof ConvexError) {
          await removePendingAttendanceScan({
            eventSlug,
            installationId: reserved.installationId,
            deviceSequence: reserved.lastIssuedSequence,
          });
          await refreshPendingSummary();
          throw error;
        }
        setHeartbeatState({
          status: "error",
          message: "We could not confirm whether the scan was accepted.",
        });
        setPendingConfirmation(
          "Saved on this phone. It is pending—not accepted—and will retry safely.",
        );
        return;
      }
      try {
        await removePendingAttendanceScan({
          eventSlug,
          installationId: reserved.installationId,
          deviceSequence: reserved.lastIssuedSequence,
        });
        await refreshPendingSummary();
      } catch (error) {
        setReplayStatus(
          errorMessage(
            error,
            "The accepted scan will be cleared from the local queue on its idempotent retry.",
          ),
        );
      }
      setReceipt(result);
      setPendingScan(null);
    } catch (error) {
      setScanError(errorMessage(error, "The scan could not be recorded."));
    }
  };

  const handleCredentialBarcode = async (scan: BarcodeScanningResult) => {
    if (credentialSetup.step === "participant") {
      const participantQr = parseAttendanceQrPayload(scan.data);
      let participant: StaffedParticipant;
      let resolutionSource: "vit_barcode" | "external_pass" | "external_id";
      if (participantQr?.kind === "external_pass") {
        resolutionSource = "external_pass";
        participant = await resolveExternalPass({
          eventSlug,
          stationId: assignment.station.id,
          expectedConfigurationVersion: assignment.station.configurationVersion,
          deviceInstallationId: assignment.device.id,
          deviceSecret: deviceRecord.deviceSecret,
          passBearer: participantQr.bearer,
        });
      } else {
        resolutionSource = "vit_barcode";
        if (participantQr) {
          throw new OperatorError("Use the personal external event pass, not a badge QR.");
        }
        const read = findBarcodeSymbology(scan.type);
        const symbology = allowedVitBarcode(read, assignment);
        if (!symbology) throw new OperatorError(unreadableCredential(read, assignment));
        const isExternalCard = physicalCardKind(scan.data) === "external_id_barcode";
        resolutionSource = isExternalCard ? "external_id" : "vit_barcode";
        try {
          participant = await (isExternalCard ? resolveExternalIdBarcode : resolveVitBarcode)({
            eventSlug,
            stationId: assignment.station.id,
            expectedConfigurationVersion: assignment.station.configurationVersion,
            deviceInstallationId: assignment.device.id,
            deviceSecret: deviceRecord.deviceSecret,
            rawBarcodeValue: scan.data,
            symbology,
          });
        } catch (error) {
          if (
            isExternalCard && error instanceof ConvexError &&
            typeof error.data === "object" && error.data !== null &&
            "code" in error.data && error.data.code === "EXTERNAL_ID_NOT_LINKED"
          ) {
            setManualLookupKind("external_email");
            setManualLookupOpen(true);
          }
          throw error;
        }
      }
      setVenueReason("");
      setVenueCheckInReceipt(null);
      setCredentialSetup({ step: "identity", participant, resolutionSource });
      return;
    }
    if (credentialSetup.step !== "first_scan" && credentialSetup.step !== "second_scan") return;
    const participant = credentialSetup.participant;
    const credential = participant.credential;
    if (credential.kind === "external_pass") {
      const participantQr = parseAttendanceQrPayload(scan.data);
      if (participantQr) {
        throw new OperatorError("Now scan the barcode on the participant's physical ID, not an event QR.");
      }
      const read = findBarcodeSymbology(scan.type);
      const symbology = allowedVitBarcode(read, assignment);
      if (!symbology) {
        throw new OperatorError(
          "This physical ID barcode format is not enabled for the event. Use email lookup and visually verify the ID instead.",
        );
      }
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        rawBarcodeValue: scan.data,
        symbology,
        visibleIdentityConfirmed: true,
      };
      await runPersistentClientOperation({
        eventSlug,
        slot: "attendance.external-id.link",
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) =>
          linkResolvedExternalIdBarcode({ ...request, clientOperationId }),
      });
      setCredentialSetup({ step: "complete", participant, outcome: "external_id_linked" });
      return;
    }
    if (credential.kind === "badge_qr") {
      const badgeQr = parseAttendanceQrPayload(scan.data);
      if (!badgeQr || badgeQr.kind !== "badge_qr") {
        throw new OperatorError("This needs the QR on their printed badge, not this code.");
      }
      if (credentialSetup.step === "first_scan") {
        const result =
          credential.state === "active"
            ? await runPersistentClientOperation({
                eventSlug,
                slot: "attendance.badge.begin",
                fingerprint: operationFingerprint({
                  eventSlug,
                  stationId: assignment.station.id,
                  expectedConfigurationVersion: assignment.station.configurationVersion,
                  deviceInstallationId: assignment.device.id,
                  deviceSecret: deviceRecord.deviceSecret,
                  resolutionId: participant.resolutionId,
                  membershipId: participant.membershipId,
                  priorCredentialId: credential.credentialId,
                  expectedPriorCredentialVersion: credential.expectedCredentialVersion,
                  badgeBearer: badgeQr.bearer,
                  visibleIdentityConfirmed: true,
                  reason: credentialReason,
                }),
                execute: (clientOperationId) =>
                  beginExternalBadgeReplacement({
                    clientOperationId,
                    eventSlug,
                    stationId: assignment.station.id,
                    expectedConfigurationVersion: assignment.station.configurationVersion,
                    deviceInstallationId: assignment.device.id,
                    deviceSecret: deviceRecord.deviceSecret,
                    resolutionId: participant.resolutionId,
                    membershipId: participant.membershipId,
                    priorCredentialId: credential.credentialId,
                    expectedPriorCredentialVersion: credential.expectedCredentialVersion,
                    badgeBearer: badgeQr.bearer,
                    visibleIdentityConfirmed: true,
                    reason: credentialReason,
                  }),
              })
            : await runPersistentClientOperation({
                eventSlug,
                slot: "attendance.badge.begin",
                fingerprint: operationFingerprint({
                  eventSlug,
                  stationId: assignment.station.id,
                  expectedConfigurationVersion: assignment.station.configurationVersion,
                  deviceInstallationId: assignment.device.id,
                  deviceSecret: deviceRecord.deviceSecret,
                  resolutionId: participant.resolutionId,
                  membershipId: participant.membershipId,
                  badgeBearer: badgeQr.bearer,
                  visibleIdentityConfirmed: true,
                }),
                execute: (clientOperationId) =>
                  beginExternalBadgeIssue({
                    clientOperationId,
                    eventSlug,
                    stationId: assignment.station.id,
                    expectedConfigurationVersion: assignment.station.configurationVersion,
                    deviceInstallationId: assignment.device.id,
                    deviceSecret: deviceRecord.deviceSecret,
                    resolutionId: participant.resolutionId,
                    membershipId: participant.membershipId,
                    badgeBearer: badgeQr.bearer,
                    visibleIdentityConfirmed: true,
                  }),
              });
        setCredentialSetup({
          step: "second_scan_ready",
          participant,
          credentialId: result.credentialId,
          badgeReference: result.badgeReference,
        });
        return;
      }
      if (credential.state === "active") {
        const request = {
          eventSlug,
          stationId: assignment.station.id,
          expectedConfigurationVersion: assignment.station.configurationVersion,
          deviceInstallationId: assignment.device.id,
          deviceSecret: deviceRecord.deviceSecret,
          resolutionId: participant.resolutionId,
          membershipId: participant.membershipId,
          priorCredentialId: credential.credentialId,
          expectedPriorCredentialVersion: credential.expectedCredentialVersion,
          replacementCredentialId: credentialSetup.credentialId,
          badgeBearer: badgeQr.bearer,
          reason: credentialReason,
        };
        await runPersistentClientOperation({
          eventSlug,
          slot: "attendance.badge.verify",
          fingerprint: operationFingerprint(request),
          execute: (clientOperationId) =>
            verifyExternalBadgeReplacement({ ...request, clientOperationId }),
        });
      } else {
        const request = {
          eventSlug,
          stationId: assignment.station.id,
          expectedConfigurationVersion: assignment.station.configurationVersion,
          deviceInstallationId: assignment.device.id,
          deviceSecret: deviceRecord.deviceSecret,
          resolutionId: participant.resolutionId,
          membershipId: participant.membershipId,
          credentialId: credentialSetup.credentialId,
          badgeBearer: badgeQr.bearer,
        };
        await runPersistentClientOperation({
          eventSlug,
          slot: "attendance.badge.verify",
          fingerprint: operationFingerprint(request),
          execute: (clientOperationId) =>
            verifyExternalBadgeIssue({ ...request, clientOperationId }),
        });
      }
      setCredentialSetup({
        step: "complete",
        participant,
        outcome: credential.state === "active" ? "badge_replaced" : "badge_issued",
      });
      return;
    }
    if (parseAttendanceQrPayload(scan.data)) {
      throw new OperatorError("Scan the barcode printed on their VIT ID, not an event QR.");
    }
    const read = findBarcodeSymbology(scan.type);
    const symbology = allowedVitBarcode(read, assignment);
    if (!symbology) {
      throw new OperatorError(unreadableCredential(read, assignment));
    }
    if (credentialSetup.step === "first_scan") {
      const replacing = credential.state === "active" || credential.state === "suspended";
      const result = replacing
        ? await runPersistentClientOperation({
            eventSlug,
            slot: "attendance.vit.begin",
            fingerprint: operationFingerprint({
              eventSlug,
              stationId: assignment.station.id,
              expectedConfigurationVersion: assignment.station.configurationVersion,
              deviceInstallationId: assignment.device.id,
              deviceSecret: deviceRecord.deviceSecret,
              resolutionId: participant.resolutionId,
              membershipId: participant.membershipId,
              priorCredentialId: credential.credentialId,
              expectedPriorCredentialVersion: credential.expectedCredentialVersion,
              rawBarcodeValue: scan.data,
              symbology,
              visibleIdentityConfirmed: true,
              reason: credentialReason,
            }),
            execute: (clientOperationId) =>
              beginVitBarcodeRebind({
                clientOperationId,
                eventSlug,
                stationId: assignment.station.id,
                expectedConfigurationVersion: assignment.station.configurationVersion,
                deviceInstallationId: assignment.device.id,
                deviceSecret: deviceRecord.deviceSecret,
                resolutionId: participant.resolutionId,
                membershipId: participant.membershipId,
                priorCredentialId: credential.credentialId,
                expectedPriorCredentialVersion: credential.expectedCredentialVersion,
                rawBarcodeValue: scan.data,
                symbology,
                visibleIdentityConfirmed: true,
                reason: credentialReason,
              }),
          })
        : await runPersistentClientOperation({
            eventSlug,
            slot: "attendance.vit.begin",
            fingerprint: operationFingerprint({
              eventSlug,
              stationId: assignment.station.id,
              expectedConfigurationVersion: assignment.station.configurationVersion,
              deviceInstallationId: assignment.device.id,
              deviceSecret: deviceRecord.deviceSecret,
              resolutionId: participant.resolutionId,
              membershipId: participant.membershipId,
              rawBarcodeValue: scan.data,
              symbology,
              visibleIdentityConfirmed: true,
            }),
            execute: (clientOperationId) =>
              beginVitBarcodeEnrollment({
                clientOperationId,
                eventSlug,
                stationId: assignment.station.id,
                expectedConfigurationVersion: assignment.station.configurationVersion,
                deviceInstallationId: assignment.device.id,
                deviceSecret: deviceRecord.deviceSecret,
                resolutionId: participant.resolutionId,
                membershipId: participant.membershipId,
                rawBarcodeValue: scan.data,
                symbology,
                visibleIdentityConfirmed: true,
              }),
          });
      setCredentialSetup({
        step: "second_scan_ready",
        participant,
        credentialId: result.credentialId,
        badgeReference: null,
      });
      return;
    }
    if (credential.state === "active" || credential.state === "suspended") {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        membershipId: participant.membershipId,
        priorCredentialId: credential.credentialId,
        expectedPriorCredentialVersion: credential.expectedCredentialVersion,
        replacementCredentialId: credentialSetup.credentialId,
        rawBarcodeValue: scan.data,
        symbology,
        reason: credentialReason,
      };
      await runPersistentClientOperation({
        eventSlug,
        slot: "attendance.vit.verify",
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) => verifyVitBarcodeRebind({ ...request, clientOperationId }),
      });
    } else {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        credentialId: credentialSetup.credentialId,
        rawBarcodeValue: scan.data,
        symbology,
      };
      await runPersistentClientOperation({
        eventSlug,
        slot: "attendance.vit.verify",
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) =>
          verifyVitBarcodeEnrollment({ ...request, clientOperationId }),
      });
    }
    setCredentialSetup({
      step: "complete",
      participant,
      outcome:
        credential.state === "active" || credential.state === "suspended"
          ? "vit_replaced"
          : "vit_enrolled",
    });
  };

  const handleBadgeRevoke = async () => {
    if (busyRef.current || credentialSetup.step !== "identity") return;
    const participant = credentialSetup.participant;
    const badgeSetup = participant.credential;
    if (
      badgeSetup.kind !== "badge_qr" ||
      badgeSetup.state !== "active" ||
      !badgeSetup.canRevoke ||
      credentialReason.trim().length < 5
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setScanError(null);
    try {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        membershipId: participant.membershipId,
        credentialId: badgeSetup.credentialId,
        expectedCredentialVersion: badgeSetup.expectedCredentialVersion,
        visibleIdentityConfirmed: true,
        reason: credentialReason,
      };
      await runPersistentClientOperation({
        eventSlug,
        slot: "attendance.badge.revoke",
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) => revokeExternalBadge({ ...request, clientOperationId }),
      });
      setCredentialSetup({ step: "complete", participant, outcome: "badge_revoked" });
    } catch (error) {
      setScanError(errorMessage(error, "The event badge could not be revoked."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleVitSuspend = async () => {
    if (busyRef.current || credentialSetup.step !== "identity") return;
    const participant = credentialSetup.participant;
    const setup = participant.credential;
    if (
      setup.kind !== "vit_id_barcode" ||
      setup.state !== "active" ||
      !setup.canSuspend ||
      credentialReason.trim().length < 5
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setScanError(null);
    try {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        membershipId: participant.membershipId,
        credentialId: setup.credentialId,
        expectedCredentialVersion: setup.expectedCredentialVersion,
        visibleIdentityConfirmed: true,
        reason: credentialReason,
      };
      await runPersistentClientOperation({
        eventSlug,
        slot: "attendance.vit.suspend",
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) => suspendVitBarcode({ ...request, clientOperationId }),
      });
      setCredentialSetup({ step: "complete", participant, outcome: "vit_suspended" });
    } catch (error) {
      setScanError(errorMessage(error, "The VIT ID could not be suspended."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleExternalPassChange = async (operation: "suspend" | "reissue") => {
    if (busyRef.current || credentialSetup.step !== "identity") return;
    const participant = credentialSetup.participant;
    const pass = participant.credential;
    if (
      pass.kind !== "external_pass" ||
      pass.state === "not_issued" ||
      (operation === "suspend" ? !pass.canSuspend : !pass.canReissue) ||
      credentialReason.trim().length < 5
    ) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setScanError(null);
    try {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        membershipId: participant.membershipId,
        passId: pass.passId,
        expectedPassVersion: pass.expectedPassVersion,
        visibleIdentityConfirmed: true,
        reason: credentialReason,
      };
      const slot = `attendance.external-pass.${operation}` as const;
      await runPersistentClientOperation({
        eventSlug,
        slot,
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) =>
          operation === "suspend"
            ? suspendExternalPass({ ...request, clientOperationId })
            : reissueExternalPass({ ...request, clientOperationId }),
      });
      setCredentialSetup({
        step: "complete",
        participant,
        outcome:
          operation === "suspend" ? "external_pass_suspended" : "external_pass_reissued",
      });
      setCredentialReason("");
    } catch (error) {
      setScanError(
        errorMessage(
          error,
          operation === "suspend"
            ? "The event pass could not be suspended."
            : "The event pass could not be reissued.",
        ),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleInitialVitLink = async () => {
    if (busyRef.current || credentialSetup.step !== "identity") return;
    const { participant, resolutionSource } = credentialSetup;
    if (
      resolutionSource !== "vit_barcode" ||
      participant.credential.kind !== "vit_id_barcode" ||
      participant.credential.state !== "not_enrolled" ||
      !participant.credential.canEnrol
    ) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setScanError(null);
    try {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        visibleIdentityConfirmed: true,
      };
      await runPersistentClientOperation({
        eventSlug,
        slot: "attendance.vit.verify",
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) =>
          enrolResolvedVitBarcode({ ...request, clientOperationId }),
      });
      setCredentialSetup({ step: "complete", participant, outcome: "vit_enrolled" });
    } catch (error) {
      setScanError(errorMessage(error, "The VIT ID barcode could not be linked."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleVenueCheckIn = async (identityCheckKind: "class_id" | "approved_exception") => {
    if (
      busyRef.current ||
      venueCheckInReceipt !== null ||
      (credentialSetup.step !== "identity" && credentialSetup.step !== "complete")
    )
      return;
    const participant = credentialSetup.participant;
    if (
      currentVenueCheckIn(participant, venueCheckInReceipt) ||
      (identityCheckKind === "class_id" && !participant.canRecordVenueCheckIn) ||
      (identityCheckKind === "approved_exception" &&
        (!participant.canOverrideVenueIdentity || venueReason.trim().length < 5))
    )
      return;
    busyRef.current = true;
    setBusy(true);
    setScanError(null);
    try {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        identityCheckKind,
        visibleIdentityConfirmed: true,
        ...(identityCheckKind === "approved_exception" ? { reason: venueReason } : {}),
      };
      const result = await runPersistentClientOperation({
        eventSlug,
        slot: "attendance.venue.check-in",
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) => recordVenueCheckIn({ ...request, clientOperationId }),
      });
      setVenueCheckInReceipt(result);
      setVenueReason("");
    } catch (error) {
      setScanError(errorMessage(error, "Venue check-in could not be recorded."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleVenueCheckInReversal = async () => {
    if (
      busyRef.current ||
      venueCheckInReceipt !== null ||
      venueReason.trim().length < 5 ||
      (credentialSetup.step !== "identity" && credentialSetup.step !== "complete")
    )
      return;
    const participant = credentialSetup.participant;
    const activeCheckIn = currentVenueCheckIn(participant, venueCheckInReceipt);
    if (!activeCheckIn || !participant.canReverseVenueCheckIn) return;
    busyRef.current = true;
    setBusy(true);
    setScanError(null);
    try {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        checkInId: activeCheckIn.id,
        expectedCheckInVersion: activeCheckIn.version,
        reason: venueReason,
      };
      const result = await runPersistentClientOperation({
        eventSlug,
        slot: "attendance.venue.reverse",
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) => reverseVenueCheckIn({ ...request, clientOperationId }),
      });
      setVenueCheckInReceipt(result);
      setVenueReason("");
    } catch (error) {
      setScanError(errorMessage(error, "Venue check-in could not be reversed."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const staffedVerdict: ScanVerdict | null = scanError
    ? { colour: palette.urgent, ink: palette.text, tone: "no", detail: scanError }
    : busy
      ? { colour: palette.door, ink: palette.onDoor, tone: "wait", detail: "Checking…" }
      : null;

  const startTask = (next: ScannerTask) => {
    if (staffedRecoveryLocked && next !== "staffed") return;
    setChosenTask(next);
    router.setParams({ task: next });
    setCredentialSetup({ step: "participant" });
    setCredentialReason("");
    setVenueReason("");
    setVenueCheckInReceipt(null);
    setReceipt(null);
    setPendingConfirmation(null);
    setScanError(null);
  };

  const chooseAnotherTask = () => {
    if (staffedRecoveryLocked) return;
    setChosenTask(null);
    router.setParams({ task: "" });
    setCredentialSetup({ step: "participant" });
    setCredentialReason("");
    setVenueReason("");
    setVenueCheckInReceipt(null);
    setReceipt(null);
    setPendingConfirmation(null);
    setPendingScan(null);
    setScanError(null);
  };

  if (!permission && !cameraAccessError) {
    return (
      <SetupFrame>
        <Meta>Checking camera access…</Meta>
      </SetupFrame>
    );
  }

  if (task === null) {
    return (
      <AttendanceTaskChooser
        onFirstCheckIn={() => startTask("staffed")}
        onPresence={() => startTask("presence")}
        presenceBlocker={presenceWorkflowBlocker}
      />
    );
  }

  if ((cameraAccessError || cameraError || !permission?.granted) && scannerReady(task, credentialSetup)) {
    return (
      <>
        <SetupFrame>
          <Section title={cameraAccessError || cameraError ? "Camera unavailable" : "Camera access"}>
            {cameraAccessError || cameraError ? <Problem>{cameraAccessError ?? cameraError}</Problem> : null}
            <Action
              accent={palette.door}
              label={cameraAccessError || cameraError ? "Try camera again" : permission?.canAskAgain === false ? "Open Settings" : "Allow the camera"}
              onPress={async () => {
                if (cameraError) setCameraError(null);
                else if (cameraAccessError) await refreshCameraAccess();
                else await requestPermission();
              }}
            />
            {task === "staffed" && credentialSetup.step === "participant" ? (
              <QuietAction
                label="Continue with manual lookup"
                onPress={() => setManualLookupOpen(true)}
              />
            ) : null}
            <QuietAction label="Choose another workflow" onPress={chooseAnotherTask} />
          </Section>
        </SetupFrame>
        <ManualLookupSheet
          busy={busy}
          error={scanError}
          kind={manualLookupKind}
          onClose={() => setManualLookupOpen(false)}
          onKind={(kind) => {
            setManualLookupKind(kind);
            setManualLookupValue("");
          }}
          onSubmit={() => void handleManualLookup()}
          onValue={setManualLookupValue}
          value={manualLookupValue}
          visible={manualLookupOpen}
        />
      </>
    );
  }

  const presenceAccepted = receipt?.outcome === "accepted" || receipt?.outcome === "duplicate";
  const presenceVerdict = receipt
    ? {
        colour: presenceAccepted ? palette.judging : palette.urgent,
        ink: presenceAccepted ? palette.onJudging : palette.text,
        tone: (presenceAccepted ? "ok" : "no") as "ok" | "no",
        ...(receipt.participant ? { name: receipt.participant.displayName } : {}),
        ...(receipt.participant?.vitRegistrationNumber
          ? { registration: receipt.participant.vitRegistrationNumber }
          : {}),
        detail: receipt.outing ? outingReceiptMessage(receipt.outing, receipt.serverTime) : reasonName(receipt.reasonCode),
      }
    : scanError
      ? { colour: palette.urgent, ink: palette.text, tone: "no" as const, detail: scanError }
      : busy
        ? {
            colour: palette.door,
            ink: palette.onDoor,
            tone: "wait" as const,
            detail: "Checking this card…",
          }
        : pendingScan
          ? {
              colour: palette.door,
              ink: palette.onDoor,
              tone: "ok" as const,
              detail:
                assignment.station.mode === "roving"
                  ? "Read. Choose the permitted movement below."
                  : `Read. Confirm ${transitionName(assignment.station.mode).toLowerCase()} below.`,
            }
          : null;

  if (task === "presence") {
    return (
      <>
        <Stack.Screen
          options={{
            headerRight: () => (
              <HeaderButton
                label="Activity"
                onPress={() =>
                  router.push({
                    pathname: "/duty/door-tools",
                    params: {
                      pending: String(assignment.device.pendingReplayCount),
                      sent: String(assignment.device.lastSequence),
                    },
                  })
                }
              />
            ),
          }}
        />
        <ScanSurface
          camera={cameraFocused && appIsActive && !manualLookupOpen && !historyOpen && !reasonPickerOpen ? (
            <CameraView
              barcodeScannerSettings={{ barcodeTypes }}
              facing="back"
              onMountError={() => setCameraError("The camera could not start. Close other camera apps and try again.")}
              onBarcodeScanned={
                busy || replaying || receipt || pendingConfirmation || pendingScan || movementReason === null
                  ? undefined
                  : handleBarcode
              }
              style={StyleSheet.absoluteFill}
            />
          ) : null}
          controls={
            <ScannerTaskContext
              detail={movementReason === null ? "Choose a reason, then scan each person's ID."
                : movementReason === "short_break" && departureSelected ? "Permission required. The 15-minute timer starts when they leave."
                : departureSelected ? "Record their departure. No short-break timer or capacity limit."
                : "Scan each person coming in. Returns do not need an outing slot."}
              onChange={chooseAnotherTask}
              title={venueScanner ? (departureSelected ? "Going out" : "Coming in") : "Record presence"}
            >
              {!busy && !receipt && !pendingConfirmation ? (
                <>
                  {venueScanner ? <ChipRow
                    accent={palette.door}
                    selected={venueDirection}
                    options={[["venue_entry", "Coming in"], ["venue_exit", "Going out"]]}
                    onSelect={(direction) => {
                      if (busyRef.current || replayingRef.current) return;
                      setVenueDirection(direction);
                      setScanError(null);
                      if (direction === "venue_exit" && movementReason === "general") {
                        setMovementReason(null);
                        setReasonPickerOpen(true);
                      }
                      if (direction === "venue_entry" && movementReason === null) setMovementReason("general");
                    }}
                  /> : null}
                  <Row
                    label={movementReason ? attendanceMovementReasonLabels[movementReason] : "Choose a reason"}
                    detail={movementReason ? "Tap to change reason" : "Required before scanning"}
                    onPress={() => {
                      if (busyRef.current || replayingRef.current) return;
                      setReasonPickerOpen(true);
                    }}
                  />
                </>
              ) : movementReason ? <Meta>{attendanceMovementReasonLabels[movementReason]}</Meta> : null}
              {staffedOperations.records.size > 0 ? (
                <Meta>
                  Finish the earlier credential action with the exact same participant and card.
                </Meta>
              ) : null}
            </ScannerTaskContext>
          }
          {...(presenceVerdict ? { verdict: presenceVerdict } : {})}
          result={
            <>
              {washroomQueue ? <Meta>{washroomQueue.capacity === null ? "Short-break capacity needs setup in Ops." : `${washroomQueue.occupiedCount}/${washroomQueue.capacity} short-break slots occupied · ${washroomQueue.waitingCount} waiting`}{washroomQueue.next[0] ? ` · Next: ${washroomQueue.next[0].displayName}` : ""}</Meta> : null}
              {receipt || scanError ? (
                <>
                  {receipt?.participant?.teamName ? (
                    <Meta>{receipt.participant.teamName}</Meta>
                  ) : null}
                  {receipt?.reasonCode === "external_id_not_linked" ? <Action label="Link external card" onPress={() => {
                    startTask("staffed"); setManualLookupKind("external_email"); setManualLookupOpen(true);
                  }} /> : null}
                  <Action
                    accent={palette.door}
                    label="Scan next"
                    onPress={() => {
                      setReceipt(null);
                      setScanError(null);
                      setPendingScan(null);
                    }}
                  />
                </>
              ) : pendingScan ? (
                <>
                  {assignment.station.mode === "roving" ? (
                    rovingTransitions.map((option) => (
                      <Action
                        accent={palette.door}
                        key={option}
                        label={transitionName(option)}
                        onPress={() => void submitPendingScan(option)}
                      />
                    ))
                  ) : (
                    <Action
                      accent={palette.door}
                      label={`Confirm ${transitionName(assignment.station.mode).toLowerCase()}`}
                      onPress={() => void submitPendingScan(undefined)}
                    />
                  )}
                  <Action destructive label="Cancel" onPress={() => setPendingScan(null)} />
                </>
              ) : (
                <>
                  {pendingSummary.count > 0 ? (
                    <Meta>
                      {pendingSummary.count} scan{pendingSummary.count === 1 ? "" : "s"} still to
                      send
                    </Meta>
                  ) : null}
                  {replayStatus ? <Meta>{replayStatus}</Meta> : null}
                  {latestReplayReceipt ? (
                    <Meta>
                      Sent late · {outcomeName(latestReplayReceipt.outcome)}
                      {latestReplayReceipt.participantName
                        ? ` · ${latestReplayReceipt.participantName}`
                        : ""}
                    </Meta>
                  ) : null}
                  <Row
                    {...(deviceHistory.results[0]
                      ? { detail: receiptLine(deviceHistory.results[0]) }
                      : {})}
                    label="Scan history"
                    onPress={() => setHistoryOpen(true)}
                  />
                </>
              )}
            </>
          }
        />
        <Sheet
          detents={[0.65]}
          onClose={() => setReasonPickerOpen(false)}
          title={departureSelected ? "Reason for leaving" : "Reason for coming in"}
          visible={reasonPickerOpen}
        >
          {attendanceMovementReasons.filter((reason) => !departureSelected || reason !== "general").map((reason) => (
            <Row
              key={reason}
              label={attendanceMovementReasonLabels[reason]}
              detail={reason === "short_break" ? "15-minute permission on departure; release the slot on return."
                : reason === "general" ? "Confirm they are inside."
                : "Flexible return. No short-break timer."}
              onPress={() => {
                setMovementReason(reason);
                setReasonPickerOpen(false);
                setScanError(null);
              }}
            />
          ))}
        </Sheet>
        <Sheet
          detents={[0.45, 0.92]}
          onClose={() => setHistoryOpen(false)}
          title="Scan history"
          visible={historyOpen}
        >
          {deviceHistory.results.length === 0 ? (
            deviceHistory.status === "LoadingFirstPage" ? (
              <CaseListSkeleton rows={4} />
            ) : (
              <Nothing>No receipts have come back to this phone yet.</Nothing>
            )
          ) : (
            <FlatList
              contentContainerStyle={styles.historyContent}
              data={deviceHistory.results}
              keyExtractor={(entry) => String(entry.deviceSequence)}
              onEndReached={() => {
                if (deviceHistory.status === "CanLoadMore") deviceHistory.loadMore(50);
              }}
              onEndReachedThreshold={0.5}
              renderItem={({ item: entry }) => (
                <Row
                  danger={entry.outcome === "rejected" || entry.outcome === "needs_review"}
                  detail={receiptDetail(entry)}
                  label={entry.participantName ?? outcomeName(entry.outcome)}
                />
              )}
              style={styles.historyList}
              {...(deviceHistory.status === "LoadingMore"
                ? { ListFooterComponent: <CaseListSkeleton rows={2} /> }
                : {})}
            />
          )}
        </Sheet>
      </>
    );
  }

  const staffedCameraStep =
    credentialSetup.step === "participant" ||
    credentialSetup.step === "first_scan" ||
    credentialSetup.step === "second_scan";
  if (!staffedCameraStep) {
    return (
      <ScrollView
        contentContainerStyle={styles.credentialPage}
        contentInsetAdjustmentBehavior="automatic"
      >
        {displayedHeartbeatState.status === "error" ? (
          <Problem>{displayedHeartbeatState.message}</Problem>
        ) : null}
        <CredentialSetupInstructions
          credentialSetup={credentialSetup}
          reason={credentialReason}
          onReason={setCredentialReason}
          venueReason={venueReason}
          onVenueReason={setVenueReason}
          venueCheckInReceipt={venueCheckInReceipt}
          onVenueCheckIn={() => handleVenueCheckIn("class_id")}
          onVenueIdentityException={() => handleVenueCheckIn("approved_exception")}
          onVenueCheckInReversal={handleVenueCheckInReversal}
          onConfirmIdentity={() => {
            if (
              credentialSetup.step === "identity" &&
              credentialCanStartScan(credentialSetup.participant, credentialReason)
            ) {
              if (
                credentialSetup.resolutionSource === "vit_barcode" &&
                credentialSetup.participant.credential.kind === "vit_id_barcode" &&
                credentialSetup.participant.credential.state === "not_enrolled"
              ) {
                void handleInitialVitLink();
                return;
              }
              setCredentialSetup({
                step: "first_scan",
                participant: credentialSetup.participant,
              });
              setScanError(null);
            }
          }}
          onExternalPassReissue={() => handleExternalPassChange("reissue")}
          onExternalPassSuspend={() => handleExternalPassChange("suspend")}
          onRevoke={handleBadgeRevoke}
          onSuspend={handleVitSuspend}
          onSecondScan={() => {
            if (credentialSetup.step === "second_scan_ready") {
              setCredentialSetup({
                step: "second_scan",
                participant: credentialSetup.participant,
                credentialId: credentialSetup.credentialId,
                badgeReference: credentialSetup.badgeReference,
              });
              setScanError(null);
            }
          }}
          onReset={() => {
            if (staffedRecoveryLocked) return;
            setCredentialSetup({ step: "participant" });
            setCredentialReason("");
            setVenueReason("");
            setVenueCheckInReceipt(null);
            setScanError(null);
          }}
          resetDisabled={staffedRecoveryLocked}
        />
        {scanError ? <Problem>{scanError}</Problem> : null}
        {scanError ? <QuietAction label="Try again" onPress={() => setScanError(null)} /> : null}
      </ScrollView>
    );
  }

  const staffedPrompt = staffedScannerPrompt(credentialSetup);

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton
              label="Activity"
              onPress={() =>
                router.push({
                  pathname: "/duty/door-tools",
                  params: {
                    pending: String(assignment.device.pendingReplayCount),
                    sent: String(assignment.device.lastSequence),
                  },
                })
              }
            />
          ),
        }}
      />
      <ScanSurface
        camera={cameraFocused && appIsActive && !manualLookupOpen && !historyOpen ? (
          <CameraView
            barcodeScannerSettings={{ barcodeTypes }}
            facing="back"
            onMountError={() => setCameraError("The camera could not start. Close other camera apps and try again.")}
            onBarcodeScanned={
              busy || replaying || !scannerReady(task, credentialSetup) ? undefined : handleBarcode
            }
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        controls={
          <ScannerTaskContext
            detail={staffedPrompt.detail}
            onChange={chooseAnotherTask}
            title={staffedPrompt.title}
          >
            {staffedOperations.error ? <Problem>{staffedOperations.error}</Problem> : null}
            {staffedOperations.records.size > 0 ? (
              <Meta>Finish the earlier credential action before leaving this task.</Meta>
            ) : null}
          </ScannerTaskContext>
        }
        {...(staffedVerdict ? { verdict: staffedVerdict } : {})}
        result={
          credentialSetup.step === "participant" &&
          !scanError &&
          displayedHeartbeatState.status !== "error" ? (
            <FirstCheckInPrompt onManualLookup={() => setManualLookupOpen(true)} />
          ) : (
            <ScrollView
              contentContainerStyle={styles.credentialDockContent}
              showsVerticalScrollIndicator={false}
              style={styles.credentialDock}
            >
              {displayedHeartbeatState.status === "error" ? (
                <Problem>{displayedHeartbeatState.message}</Problem>
              ) : null}
              <CredentialSetupInstructions
                credentialSetup={credentialSetup}
                reason={credentialReason}
                onReason={setCredentialReason}
                venueReason={venueReason}
                onVenueReason={setVenueReason}
                venueCheckInReceipt={venueCheckInReceipt}
                onVenueCheckIn={() => handleVenueCheckIn("class_id")}
                onVenueIdentityException={() => handleVenueCheckIn("approved_exception")}
                onVenueCheckInReversal={handleVenueCheckInReversal}
                onConfirmIdentity={() => void handleInitialVitLink()}
                onExternalPassReissue={() => handleExternalPassChange("reissue")}
                onExternalPassSuspend={() => handleExternalPassChange("suspend")}
                onRevoke={handleBadgeRevoke}
                onSuspend={handleVitSuspend}
                onSecondScan={() => {}}
                onReset={() => {
                  if (staffedRecoveryLocked) return;
                  setCredentialSetup({ step: "participant" });
                  setCredentialReason("");
                  setVenueReason("");
                  setVenueCheckInReceipt(null);
                  setScanError(null);
                }}
                resetDisabled={staffedRecoveryLocked}
              />
              {scanError ? (
                <QuietAction label="Try again" onPress={() => setScanError(null)} />
              ) : null}
            </ScrollView>
          )
        }
      />
      <ManualLookupSheet
        busy={busy}
        error={scanError}
        kind={manualLookupKind}
        onClose={() => setManualLookupOpen(false)}
        onKind={(kind) => {
          setManualLookupKind(kind);
          setManualLookupValue("");
        }}
        onSubmit={() => void handleManualLookup()}
        onValue={setManualLookupValue}
        value={manualLookupValue}
        visible={manualLookupOpen}
      />
    </>
  );
}

function ManualLookupSheet({
  busy,
  error,
  kind,
  onClose,
  onKind,
  onSubmit,
  onValue,
  value,
  visible,
}: {
  busy: boolean;
  error: string | null;
  kind: ManualLookupKind;
  onClose: () => void;
  onKind: (kind: ManualLookupKind) => void;
  onSubmit: () => void;
  onValue: (value: string) => void;
  value: string;
  visible: boolean;
}) {
  return (
    <Sheet detents={[0.72]} onClose={onClose} title="Find participant" visible={visible}>
      <Body>
        Use this only when the participant’s ID barcode or event pass cannot be read.
      </Body>
      <ChipRow
        accent={palette.door}
        onSelect={onKind}
        options={[
          ["vit_registration", "VIT registration"],
          ["external_email", "External email"],
        ]}
        selected={kind}
      />
      <Field
        autoCapitalize={kind === "vit_registration" ? "characters" : "none"}
        keyboardType={kind === "external_email" ? "email-address" : "default"}
        label={kind === "vit_registration" ? "Registration number" : "Email"}
        maxLength={kind === "vit_registration" ? 9 : 254}
        onChangeText={onValue}
        placeholder={kind === "vit_registration" ? "24BCI0150" : "name@example.com"}
        value={value}
      />
      <Action
        accent={palette.door}
        disabled={busy || value.trim().length === 0}
        label={busy ? "Searching…" : "Find participant"}
        onPress={onSubmit}
      />
      {error ? <Problem>{error}</Problem> : null}
    </Sheet>
  );
}

function AttendanceTaskChooser({
  onFirstCheckIn,
  onPresence,
  presenceBlocker,
}: {
  onFirstCheckIn: () => void;
  onPresence: () => void;
  presenceBlocker: string | null;
}) {
  return (
    <ScrollView
      contentContainerStyle={styles.taskChooser}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={styles.chooserHeading}>
        <Text style={styles.chooserTitle}>What are you recording?</Text>
        <Text style={styles.chooserLead}>Choose before opening the camera.</Text>
      </View>
      <WorkflowCard
        badge="ARRIVAL"
        detail="Identify an accepted participant and record their first arrival at the venue."
        onPress={onFirstCheckIn}
        title="First check-in"
      />
      <WorkflowCard
        badge="MOVEMENT"
        detail="For someone already checked in: sessions, exits, returns, and zone movement."
        disabled={presenceBlocker !== null}
        onPress={onPresence}
        title="Record presence"
      />
      {presenceBlocker ? <Problem>{presenceBlocker}</Problem> : null}
    </ScrollView>
  );
}

function WorkflowCard({
  badge,
  detail,
  disabled = false,
  onPress,
  title,
}: {
  badge: string;
  detail: string;
  disabled?: boolean;
  onPress: () => void;
  title: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.workflowCard,
        disabled ? styles.workflowCardDisabled : null,
        pressed ? styles.workflowCardPressed : null,
      ]}
    >
      <View style={styles.workflowCardTop}>
        <Text style={styles.workflowBadge}>{badge}</Text>
        <Text style={styles.workflowArrow}>→</Text>
      </View>
      <Text style={styles.workflowTitle}>{title}</Text>
      <Text style={styles.workflowDetail}>{detail}</Text>
    </Pressable>
  );
}

function FirstCheckInPrompt({ onManualLookup }: { onManualLookup: () => void }) {
  return (
    <View style={styles.firstCheckInPrompt}>
      <Text style={styles.promptEyebrow}>READY TO SCAN</Text>
      <View style={styles.scanPaths}>
        <View style={styles.scanPath}>
          <View style={styles.scanPathNumber}>
            <Text style={styles.scanPathNumberText}>VIT</Text>
          </View>
          <View style={styles.scanPathCopy}>
            <Text style={styles.scanPathTitle}>Internal participant</Text>
            <Text style={styles.scanPathDetail}>Scan the barcode on their VIT ID.</Text>
          </View>
        </View>
        <View style={styles.scanPathDivider} />
        <View style={styles.scanPath}>
          <View style={styles.scanPathNumber}>
            <Text style={styles.scanPathNumberText}>EXT</Text>
          </View>
          <View style={styles.scanPathCopy}>
            <Text style={styles.scanPathTitle}>External participant</Text>
            <Text style={styles.scanPathDetail}>Scan their emailed event pass first.</Text>
          </View>
        </View>
      </View>
      <QuietAction label="Barcode not scanning? Find participant" onPress={onManualLookup} />
    </View>
  );
}

function staffedScannerPrompt(credentialSetup: CredentialSetupState) {
  if (credentialSetup.step === "participant") {
    return {
      title: "First check-in",
      detail: "Scan a VIT ID, graVITas external ID, or event pass.",
    };
  }
  if (credentialSetup.step === "first_scan") {
    if (credentialSetup.participant.credential.kind === "external_pass") {
      return {
        title: "Scan physical photo ID",
        detail: "The external pass matched. Now scan the barcode on the ID you verified.",
      };
    }
    if (credentialSetup.participant.credential.kind === "badge_qr") {
      return {
        title: "Scan printed badge",
        detail: "Place the unused badge QR inside the frame.",
      };
    }
    return {
      title: "Scan replacement VIT ID",
      detail: "Place the barcode on the replacement card inside the frame.",
    };
  }
  if (credentialSetup.step === "second_scan") {
    return {
      title: "Verify the same card",
      detail: credentialSetup.badgeReference
        ? `Scan badge ${credentialSetup.badgeReference} once more.`
        : "Move the VIT ID away, then scan the same barcode once more.",
    };
  }
  return { title: "First check-in", detail: "Complete the participant check below." };
}

function ScannerTaskContext({
  children,
  detail,
  onChange,
  title,
}: {
  children?: ReactNode;
  detail: string;
  onChange: () => void;
  title: string;
}) {
  return (
    <View style={styles.taskContext}>
      <View style={styles.taskContextHeader}>
        <View style={styles.taskContextCopy}>
          <Text style={styles.taskContextTitle}>{title}</Text>
          <Text numberOfLines={2} style={styles.taskContextDetail}>
            {detail}
          </Text>
        </View>
        <Pressable
          accessibilityLabel="Choose another workflow"
          accessibilityRole="button"
          hitSlop={10}
          onPress={onChange}
          style={({ pressed }) => [
            styles.changeWorkflow,
            pressed ? styles.changeWorkflowPressed : null,
          ]}
        >
          <Text style={styles.changeWorkflowText}>Change</Text>
        </Pressable>
      </View>
      {children}
    </View>
  );
}

function CheckInProgress({ current }: { current: 1 | 2 | 3 }) {
  const steps = ["Identify", "Verify ID", "Check in"] as const;
  return (
    <View accessibilityLabel={`First check-in step ${current} of 3`} style={styles.checkInProgress}>
      {steps.map((step, index) => {
        const stepNumber = index + 1;
        const active = stepNumber <= current;
        return (
          <View key={step} style={styles.checkInProgressStep}>
            <View style={[styles.checkInProgressLine, active ? styles.checkInProgressLineActive : null]} />
            <Text style={[styles.checkInProgressLabel, active ? styles.checkInProgressLabelActive : null]}>
              {step}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function ParticipantIdentityCard({ participant }: { participant: StaffedParticipant }) {
  return (
    <View style={styles.participantCard}>
      <View style={styles.participantAvatar}>
        <Text style={styles.participantAvatarText}>
          {participant.displayName.trim().slice(0, 1).toLocaleUpperCase("en")}
        </Text>
      </View>
      <View style={styles.participantCopy}>
        <Text numberOfLines={2} style={styles.participantName}>
          {participant.displayName}
        </Text>
        {participant.vitRegistrationNumber ? (
          <Text style={styles.credentialRegistration}>{participant.vitRegistrationNumber}</Text>
        ) : (
          <Text style={styles.participantClass}>EXTERNAL PARTICIPANT</Text>
        )}
        <Text numberOfLines={2} style={styles.participantDetail}>
          {participant.teamName} · {participant.institution}
        </Text>
      </View>
    </View>
  );
}

function CredentialSetupInstructions({
  credentialSetup,
  reason,
  onReason,
  venueReason,
  onVenueReason,
  venueCheckInReceipt,
  onVenueCheckIn,
  onVenueIdentityException,
  onVenueCheckInReversal,
  onConfirmIdentity,
  onExternalPassReissue,
  onExternalPassSuspend,
  onRevoke,
  onSuspend,
  onSecondScan,
  onReset,
  resetDisabled,
}: {
  credentialSetup: CredentialSetupState;
  reason: string;
  onReason: (value: string) => void;
  venueReason: string;
  onVenueReason: (value: string) => void;
  venueCheckInReceipt: VenueCheckInReceipt | null;
  onVenueCheckIn: () => void | Promise<void>;
  onVenueIdentityException: () => void | Promise<void>;
  onVenueCheckInReversal: () => void | Promise<void>;
  onConfirmIdentity: () => void;
  onExternalPassReissue: () => void | Promise<void>;
  onExternalPassSuspend: () => void | Promise<void>;
  onRevoke: () => void | Promise<void>;
  onSuspend: () => void | Promise<void>;
  onSecondScan: () => void;
  onReset: () => void;
  resetDisabled: boolean;
}) {
  if (credentialSetup.step === "participant") {
    return null;
  }

  if (credentialSetup.step === "identity") {
    const participant = credentialSetup.participant;
    const credential = participant.credential;
    const checkedIn = currentVenueCheckIn(participant, venueCheckInReceipt) !== null;
    const manualResolution = credentialSetup.resolutionSource === "manual";
    const currentVitIdRecognized = participant.vitScanRelationship === "current_active";
    const needsReason =
      !currentVitIdRecognized &&
      credential.kind !== "external_pass" &&
      (credential.state === "active" || credential.state === "suspended");
    const canManageExternalPass =
      credential.kind === "external_pass" &&
      credential.state !== "not_issued" &&
      (credential.canSuspend || credential.canReissue);
    const canChangeCredential =
      credential.kind === "external_pass"
        ? credentialSetup.resolutionSource !== "external_id"
        : credential.kind === "vit_id_barcode" && credential.state === "not_enrolled"
        ? credential.canEnrol && credentialSetup.resolutionSource === "vit_barcode"
        : credential.kind === "vit_id_barcode"
          ? !currentVitIdRecognized && credential.canRebind
          : credential.state === "not_issued"
            ? credential.canIssue
            : credential.canReplace;
    const suspendedVitIdRecognized = participant.vitScanRelationship === "current_suspended";
    const venueCheckInReady =
      manualResolution || credentialSetup.resolutionSource === "external_id" || currentVitIdRecognized || suspendedVitIdRecognized;
    return (
      <>
        <CheckInProgress current={1} />
        <ParticipantIdentityCard participant={participant} />
        {credential.kind === "badge_qr" && credential.state === "active" ? (
          <Meta>Active badge {credential.badgeReference}</Meta>
        ) : null}
        <Body>{identityInstruction(participant, credentialSetup.resolutionSource)}</Body>
        {participant.vitScanRelationship === "current_suspended" ? (
          <Problem>
            This exact VIT ID is suspended. Replace it with a different card, or use an approved
            identity exception.
          </Problem>
        ) : null}
        {venueCheckInReady ? (
          <VenueCheckInControls
            classIdReady={manualResolution || currentVitIdRecognized}
            participant={participant}
            receipt={venueCheckInReceipt}
            reason={venueReason}
            onReason={onVenueReason}
            onRecord={onVenueCheckIn}
            onException={onVenueIdentityException}
            onReverse={onVenueCheckInReversal}
          />
        ) : null}
        {needsReason ? (
          <Field
            label={
              credential.kind === "vit_id_barcode"
                ? "Why this ID binding is changing"
                : "Why this badge is changing"
            }
            maxLength={300}
            multiline
            onChangeText={onReason}
            placeholder="Reason for operations"
            value={reason}
          />
        ) : null}
        {canManageExternalPass ? (
          <Field
            label="Why this event pass is changing"
            maxLength={300}
            multiline
            onChangeText={onReason}
            placeholder="Reason for operations"
            value={reason}
          />
        ) : null}
        {canChangeCredential ? (
          <Action
            accent={palette.door}
            disabled={needsReason && reason.trim().length < 5}
            label={credentialSetupActionLabel(credential)}
            onPress={onConfirmIdentity}
          />
        ) : null}
        {credential.kind === "badge_qr" && credential.state === "active" && credential.canRevoke ? (
          <QuietAction
            disabled={reason.trim().length < 5}
            label="Revoke active badge"
            onPress={onRevoke}
          />
        ) : null}
        {credential.kind === "vit_id_barcode" &&
        credential.state === "active" &&
        !currentVitIdRecognized &&
        credential.canSuspend ? (
          <QuietAction
            disabled={reason.trim().length < 5}
            label="Suspend current VIT ID"
            onPress={onSuspend}
          />
        ) : null}
        {credential.kind === "external_pass" &&
        credential.state !== "not_issued" &&
        credential.canReissue ? (
          <QuietAction
            disabled={reason.trim().length < 5}
            label="Reissue event pass"
            onPress={onExternalPassReissue}
          />
        ) : null}
        {credential.kind === "external_pass" &&
        credential.state === "active" &&
        credential.canSuspend ? (
          <QuietAction
            disabled={reason.trim().length < 5}
            label="Suspend event pass"
            onPress={onExternalPassSuspend}
          />
        ) : null}
        <Action
          destructive={!checkedIn}
          disabled={resetDisabled}
          label={checkedIn ? "Next participant" : "Cancel"}
          onPress={onReset}
        />
      </>
    );
  }
  if (credentialSetup.step === "first_scan") {
    return (
      <>
        <Meta>Step 2 of 3 · First scan</Meta>
        <Body>
          {credentialSetup.participant.credential.kind === "badge_qr"
            ? "Aim at the QR on the unused printed badge."
            : credentialSetup.participant.credential.kind === "external_pass"
              ? "Aim at the barcode on the participant's physical photo ID. Check the visible name and photo first."
              : "Aim at the barcode printed on the VIT ID."}
        </Body>
        <Action destructive disabled={resetDisabled} label="Cancel" onPress={onReset} />
      </>
    );
  }
  if (credentialSetup.step === "second_scan_ready") {
    return (
      <>
        <Meta>Step 3 of 3 · Verify</Meta>
        {credentialSetup.badgeReference ? (
          <Heading>{credentialSetup.badgeReference}</Heading>
        ) : null}
        <Body>
          {credentialSetup.badgeReference
            ? "Check this matches the printed badge. Move it away, then scan it once more."
            : "First scan matched. Move the card away, then scan it once more."}
        </Body>
        <Action accent={palette.door} label="Start verification scan" onPress={onSecondScan} />
        <Action destructive disabled={resetDisabled} label="Cancel" onPress={onReset} />
      </>
    );
  }
  if (credentialSetup.step === "second_scan") {
    return (
      <>
        <Meta>Step 3 of 3 · Verify</Meta>
        <Body>
          {credentialSetup.badgeReference
            ? `Scan badge ${credentialSetup.badgeReference} again.`
            : "Scan the same VIT ID barcode again."}
        </Body>
        <Action destructive disabled={resetDisabled} label="Cancel" onPress={onReset} />
      </>
    );
  }
  if (
    credentialSetup.outcome === "external_pass_reissued" ||
    credentialSetup.outcome === "external_pass_suspended"
  ) {
    return (
      <>
        <ParticipantIdentityCard participant={credentialSetup.participant} />
        <View style={styles.identityReady}>
          <DutyIcon color={palette.judging} name="badge" size={22} />
          <View style={styles.identityReadyCopy}>
            <Text style={styles.identityReadyTitle}>
              {credentialSetupOutcomeLabel(credentialSetup.outcome)}
            </Text>
            <Text style={styles.identityReadyDetail}>
              {credentialSetup.outcome === "external_pass_reissued"
                ? "The old QR is blocked. The replacement is available in the participant portal."
                : "The event-pass QR is blocked until staff reissue it."}
            </Text>
          </View>
        </View>
        <Action disabled={resetDisabled} label="Next participant" onPress={onReset} />
      </>
    );
  }
  const checkedIn = currentVenueCheckIn(
    credentialSetup.participant,
    venueCheckInReceipt,
  ) !== null;
  return (
    <>
      <CheckInProgress current={checkedIn ? 3 : 2} />
      <ParticipantIdentityCard participant={credentialSetup.participant} />
      <View style={styles.identityReady}>
        <DutyIcon color={palette.judging} name="badge" size={22} />
        <View style={styles.identityReadyCopy}>
          <Text style={styles.identityReadyTitle}>
            {credentialSetupOutcomeLabel(credentialSetup.outcome)}
          </Text>
          <Text style={styles.identityReadyDetail}>Identity credential is ready.</Text>
        </View>
      </View>
      <Heading>{checkedIn ? "First check-in complete" : "Record their arrival"}</Heading>
      <Body>
        {checkedIn
          ? "They are checked in and can enter the venue."
          : "Identity is ready, but first check-in is not complete until their venue arrival is recorded."}
      </Body>
      <VenueCheckInControls
        participant={credentialSetup.participant}
        receipt={venueCheckInReceipt}
        reason={venueReason}
        onReason={onVenueReason}
        onRecord={onVenueCheckIn}
        onException={onVenueIdentityException}
        onReverse={onVenueCheckInReversal}
      />
      <Action
        accent={palette.door}
        disabled={resetDisabled || !checkedIn}
        label={checkedIn ? "Next participant" : "Record check-in to continue"}
        onPress={onReset}
      />
    </>
  );
}

function identityInstruction(
  participant: StaffedParticipant,
  resolutionSource: Extract<CredentialSetupState, { step: "identity" }>["resolutionSource"],
) {
  const credential = participant.credential;
  if (resolutionSource === "manual") {
    return participant.participantClass === "vit_student"
      ? "Fallback lookup found this participant. Compare the physical VIT ID with these details before recording arrival."
      : "Fallback lookup found this participant. Compare their physical photo ID with these details. You can record arrival manually or scan the ID barcode to link it.";
  }
  if (resolutionSource === "external_id") return "Check the name and photo on this linked external card.";
  if (credential.kind === "external_pass") {
    return "Check the participant's physical photo ID matches these event-pass details, then scan its barcode to link both.";
  }
  if (credential.kind === "vit_id_barcode") {
    if (participant.vitScanRelationship === "current_active") {
      return "This is the participant's current linked VIT ID. Compare the card with these details, then record arrival.";
    }
    if (credential.state === "suspended") {
      return "This VIT ID is suspended. Bind a different card with two matching scans.";
    }
    if (credential.state === "active") {
      return "A replacement takes two matching scans. The current card works until the new one verifies.";
    }
    return "Check the VIT ID in their hand matches these details, then enrol its barcode.";
  }
  if (credential.state === "not_issued") {
    return "Check the person matches these details, then pick one unused printed badge.";
  }
  return "Check the person matches these details before replacing or revoking their badge.";
}

function VenueCheckInControls({
  classIdReady = true,
  participant,
  receipt,
  reason,
  onReason,
  onRecord,
  onException,
  onReverse,
}: {
  classIdReady?: boolean;
  participant: StaffedParticipant;
  receipt: VenueCheckInReceipt | null;
  reason: string;
  onReason: (value: string) => void;
  onRecord: () => void | Promise<void>;
  onException: () => void | Promise<void>;
  onReverse: () => void | Promise<void>;
}) {
  const activeCheckIn = currentVenueCheckIn(participant, receipt);
  if (activeCheckIn) {
    return (
      <View style={styles.block}>
        <Body>Venue check-in recorded</Body>
        <Meta>
          {new Date(activeCheckIn.checkedInAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
          {activeCheckIn.stationName ? ` · ${activeCheckIn.stationName}` : ""}
        </Meta>
        {participant.canReverseVenueCheckIn && receipt === null ? (
          <>
            <Field
              label="Why this check-in is wrong"
              maxLength={300}
              multiline
              onChangeText={onReason}
              placeholder="Reason for operations"
              value={reason}
            />
            <QuietAction
              disabled={reason.trim().length < 5}
              label="Reverse check-in"
              onPress={onReverse}
            />
          </>
        ) : receipt?.status === "checked_in" ? (
          <Meta>Resolve the participant again to reverse this check-in.</Meta>
        ) : null}
      </View>
    );
  }
  if (receipt?.status === "reversed") {
    return (
      <View style={styles.block}>
        <Body>Venue check-in reversed</Body>
        <Meta>Resolve the participant again before recording another arrival.</Meta>
      </View>
    );
  }
  const wasReversed = participant.venueCheckIn?.status === "reversed";
  if (!participant.canRecordVenueCheckIn && !participant.canOverrideVenueIdentity) {
    return (
      <View style={styles.block}>
        <Body>{wasReversed ? "This check-in was reversed" : "You cannot check people in"}</Body>
        <Meta>
          {wasReversed
            ? "This phone cannot record a new one. A coordinator can."
            : "This phone does not have access to venue check-in. Ask a coordinator to do it or to give you access."}
        </Meta>
      </View>
    );
  }
  return (
    <View style={styles.block}>
      <Body>{wasReversed ? "Venue check-in was reversed" : "Venue check-in"}</Body>
      <Meta>
        Confirm the visible {participant.participantClass === "vit_student" ? "VIT ID" : "photo ID"}{" "}
        matches these details.
      </Meta>
      {participant.canRecordVenueCheckIn && classIdReady ? (
        <Action
          accent={palette.door}
          label={
            participant.participantClass === "vit_student"
              ? "Identity matches; check in"
              : "Photo ID matches; check in"
          }
          onPress={onRecord}
        />
      ) : null}
      {participant.canOverrideVenueIdentity ? (
        <>
          <Field
            label="Approved no-ID exception"
            maxLength={300}
            multiline
            onChangeText={onReason}
            placeholder="Who approved it, and why"
            value={reason}
          />
          <QuietAction
            disabled={reason.trim().length < 5}
            label="Check in under approved exception"
            onPress={onException}
          />
        </>
      ) : null}
    </View>
  );
}

function currentVenueCheckIn(
  participant: StaffedParticipant,
  receipt: VenueCheckInReceipt | null,
): ActiveVenueCheckInView | null {
  if (receipt?.status === "checked_in") {
    return {
      id: receipt.checkInId,
      version: receipt.version,
      checkedInAt: receipt.checkedInAt,
    };
  }
  if (receipt?.status === "reversed") return null;
  if (participant.venueCheckIn?.status !== "checked_in") return null;
  return {
    id: participant.venueCheckIn.id,
    version: participant.venueCheckIn.version,
    checkedInAt: participant.venueCheckIn.checkedInAt,
    stationName: participant.venueCheckIn.stationName,
  };
}

function credentialCanStartScan(participant: StaffedParticipant, reason: string) {
  const credential = participant.credential;
  if (credential.kind === "external_pass") return true;
  if (credential.kind === "vit_id_barcode" && credential.state === "not_enrolled") {
    return credential.canEnrol;
  }
  if (credential.kind === "badge_qr" && credential.state === "not_issued") {
    return credential.canIssue;
  }
  if (credential.kind === "vit_id_barcode" && !credential.canRebind) return false;
  if (credential.kind === "badge_qr" && !credential.canReplace) return false;
  return reason.trim().length >= 5;
}

function credentialSetupActionLabel(credential: StaffedParticipant["credential"]) {
  if (credential.kind === "external_pass") return "Identity matches; scan physical ID";
  if (credential.kind === "vit_id_barcode" && credential.state === "not_enrolled") {
    return "Identity matches; link VIT ID";
  }
  if (credential.kind === "vit_id_barcode") return "Replace VIT ID barcode";
  if (credential.state === "not_issued") return "Issue event badge";
  return "Identity matches; replace badge";
}

function credentialSetupOutcomeLabel(
  outcome: Extract<CredentialSetupState, { step: "complete" }>["outcome"],
) {
  if (outcome === "vit_enrolled") return "VIT ID enrolled";
  if (outcome === "external_id_linked") return "External ID linked";
  if (outcome === "vit_replaced") return "VIT ID replaced";
  if (outcome === "vit_suspended") return "VIT ID suspended";
  if (outcome === "badge_issued") return "Badge issued";
  if (outcome === "badge_replaced") return "Badge replaced";
  if (outcome === "badge_revoked") return "Badge revoked";
  if (outcome === "external_pass_reissued") return "Event pass reissued";
  return "Event pass suspended";
}

function scannerReady(task: ScannerTask, credentialSetup: CredentialSetupState) {
  if (task === "presence") return true;
  return (
    credentialSetup.step === "participant" ||
    credentialSetup.step === "first_scan" ||
    credentialSetup.step === "second_scan"
  );
}

function scannerPlatform(): ScannerPlatform | null {
  if (Platform.OS === "android") return "android";
  if (Platform.OS === "ios") return "ios";
  return null;
}

// Detect every supported barcode, then enforce the configured format after decoding.
function scannerBarcodeTypes() {
  return [...barcodeSymbologies] as BarcodeType[];
}

const symbologyNames: Record<BarcodeSymbology, string> = {
  aztec: "Aztec",
  codabar: "Codabar",
  code39: "Code 39",
  code93: "Code 93",
  code128: "Code 128",
  datamatrix: "Data Matrix",
  ean8: "EAN-8",
  ean13: "EAN-13",
  itf14: "ITF-14",
  pdf417: "PDF417",
  qr: "QR",
  upc_a: "UPC-A",
  upc_e: "UPC-E",
};

function symbologyName(symbology: BarcodeSymbology) {
  return symbologyNames[symbology];
}

function unreadableCredential(symbology: BarcodeSymbology | null, assignment: ScannerAssignment) {
  if (symbology === null) {
    return "This code format is not supported. For first check-in, use manual lookup; otherwise ask a coordinator.";
  }
  if (symbology === "qr") {
    return "That QR is not a valid external event pass or event badge.";
  }
  const accepted = assignment.station.barcodeSymbologies
    .filter((allowed) => allowed !== "qr")
    .map(symbologyName);
  const wanted =
    accepted.length === 0
      ? "this scanner only accepts event passes and badges"
      : `this scanner reads ${listPhrase(accepted)}`;
  return `That card is a ${symbologyName(symbology)} barcode, and ${wanted}. Use manual lookup for first check-in; otherwise ask a coordinator.`;
}

function listPhrase(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function allowedVitBarcode(
  symbology: BarcodeSymbology | null,
  assignment: ScannerAssignment,
): BarcodeSymbology | null {
  return symbology && assignment.station.barcodeSymbologies.some((allowed) => allowed === symbology)
    ? symbology
    : null;
}

function credentialName(kind: ScanCredential["kind"]) {
  if (kind === "external_id_barcode") return "An external ID card";
  if (kind === "external_pass") return "An external event pass";
  if (kind === "badge_qr") return "An event badge";
  return "A VIT ID barcode";
}

function transitionName(transition: ScanTransition) {
  if (transition === "venue_entry") return "Arriving";
  if (transition === "venue_exit") return "Leaving";
  if (transition === "session_confirm") return "Session";
  if (transition === "zone_entry") return "Back in";
  return "Stepped out";
}

function receiptLine(entry: DeviceReceipt) {
  return [entry.participantName ?? outcomeName(entry.outcome), receiptDetail(entry)].join(" · ");
}

function receiptDetail(entry: DeviceReceipt) {
  return [
    entry.participantName && entry.outcome !== "accepted" ? outcomeName(entry.outcome) : null,
    transitionName(entry.transition),
    entry.movementReason ? attendanceMovementReasonLabels[entry.movementReason] : null,
    entry.outing ? outingReceiptMessage(entry.outing, entry.receivedAt) : null,
    entry.isOfflineReplay ? "replayed" : null,
    new Date(entry.capturedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

function outcomeName(outcome: ScanReceipt["outcome"]) {
  if (outcome === "accepted") return "Recorded";
  if (outcome === "duplicate") return "Already recorded";
  if (outcome === "needs_review") return "Needs review";
  return "Not recorded";
}

function reasonName(reason: string) {
  const names: Record<string, string> = {
    venue_entry_recorded: "They’re in. Send them through.",
    venue_exit_recorded: "Signed out. They can come back later.",
    session_presence_recorded: "Marked present for this session.",
    temporary_exit_recorded: "Stepped out. Scan them again on the way back.",
    already_inside: "They’re already marked inside. Let them through.",
    already_outside: "Already signed out.",
    already_present: "Already marked present for this session.",
    already_temporarily_out: "Already marked as stepped out.",
    credential_not_found:
      "This card is not registered yet. Send them to the help desk to get set up.",
    movement_already_recorded: "Movement already recorded. No change.",
    staffed_check_in_required: "Complete check-in first.",
    external_id_not_linked: "Link this external card in Check-in using the participant’s email first.",
    external_pass_invalid: "This external event pass is invalid or suspended.",
    external_identity_not_verified:
      "First check-in is incomplete. Verify and link the participant's physical photo ID first.",
    participant_not_active: "They are not signed up for the event. Send them to the help desk.",
    participant_not_expected:
      "They are not on the list for this session. Check with a coordinator.",
    session_not_open: "No session is running here right now.",
    outside_check_in_window: "Check-in for this session has closed.",
    offline_scan_needs_reconciliation:
      "Sent late, and no session was open at the time. Operations will sort it out — nothing more to do here.",
    offline_replay_conflicts_with_newer_state:
      "A later scan already counted. Operations will check this one — nothing more to do here.",
  };
  return names[reason] ?? "Operations will review this one. Carry on.";
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback);
}

type OperationFingerprintSource = object;

function operationFingerprint(value: OperationFingerprintSource) {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("The client operation cannot be serialized.");
  return encoded;
}

const styles = StyleSheet.create({
  noStation: { alignItems: "center", gap: 8, paddingVertical: 36, paddingHorizontal: 24 },
  noStationTitle: {
    marginTop: 6,
    color: palette.text,
    fontSize: 19,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  noStationBody: {
    color: palette.muted,
    fontSize: 15,
    lineHeight: 21,
    textAlign: "center",
  },
  credentialDock: { maxHeight: 440 },
  setupFrame: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 120, gap: 18 },
  credentialPage: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 120, gap: 12 },
  credentialDockContent: { gap: 14 },
  credentialRegistration: {
    color: palette.text,
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 2.2,
  },
  cameraFrame: { height: 300, overflow: "hidden", backgroundColor: "#000" },
  cameraGuide: {
    position: "absolute",
    top: 56,
    right: 40,
    bottom: 56,
    left: 40,
    borderWidth: 2,
    borderColor: palette.door,
  },

  block: {
    gap: 10,
    padding: 16,
    borderWidth: 1,
    borderColor: palette.strong,
    borderRadius: radius.tile,
    backgroundColor: palette.tile,
  },

  // Bound the list because the form sheet does not provide child height.
  historyList: { maxHeight: Math.round(Dimensions.get("window").height * 0.92) - 156 },
  historyContent: { gap: 8 },
  taskChooser: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 120, gap: 14 },
  stationCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderRadius: radius.tile,
    backgroundColor: palette.tile,
  },
  stationIcon: {
    width: 46,
    height: 46,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 23,
    backgroundColor: palette.door,
  },
  stationCopy: { flex: 1, gap: 2 },
  stationName: {
    color: palette.text,
    fontSize: 18,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  stationDetail: { color: palette.muted, fontSize: 14, lineHeight: 19 },
  taskEyebrow: {
    color: palette.door,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.1,
  },
  chooserHeading: { gap: 4, marginTop: 16, marginBottom: 2 },
  chooserTitle: {
    color: palette.text,
    fontSize: 28,
    fontWeight: "600",
    letterSpacing: -0.7,
  },
  chooserLead: { color: palette.muted, fontSize: 15, lineHeight: 21 },
  workflowCard: {
    minHeight: 156,
    justifyContent: "space-between",
    gap: 10,
    padding: 20,
    borderWidth: 1,
    borderColor: palette.strong,
    borderRadius: 16,
    backgroundColor: palette.tile,
  },
  workflowCardDisabled: { opacity: 0.42 },
  workflowCardPressed: { borderColor: palette.door, backgroundColor: "#20262C" },
  workflowCardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  workflowBadge: {
    color: palette.door,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  workflowArrow: { color: palette.door, fontSize: 24, lineHeight: 26 },
  workflowTitle: {
    color: palette.text,
    fontSize: 23,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  workflowDetail: { color: palette.muted, fontSize: 15, lineHeight: 21 },
  taskContext: {
    alignSelf: "stretch",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
    borderRadius: 14,
    backgroundColor: "rgba(10,10,11,0.88)",
  },
  taskContextHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  taskContextCopy: { flex: 1, gap: 3 },
  taskContextTitle: {
    color: palette.text,
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: -0.3,
  },
  taskContextDetail: { color: palette.muted, fontSize: 13, lineHeight: 18 },
  changeWorkflow: {
    minWidth: 66,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    borderRadius: radius.pill,
    backgroundColor: palette.strong,
  },
  changeWorkflowPressed: { opacity: 0.7 },
  changeWorkflowText: { color: palette.text, fontSize: 13, fontWeight: "600" },
  firstCheckInPrompt: { gap: 13 },
  promptEyebrow: {
    color: palette.door,
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
  },
  scanPaths: {
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: palette.strong,
    borderRadius: radius.tile,
    backgroundColor: palette.tile,
  },
  scanPath: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12 },
  scanPathDivider: { height: 1, marginLeft: 48, backgroundColor: palette.strong },
  scanPathNumber: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 18,
    backgroundColor: "#27323C",
  },
  scanPathNumberText: { color: palette.door, fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  scanPathCopy: { flex: 1, gap: 2 },
  scanPathTitle: { color: palette.text, fontSize: 15, fontWeight: "600" },
  scanPathDetail: { color: palette.muted, fontSize: 13, lineHeight: 18 },
  checkInProgress: { flexDirection: "row", gap: 7, marginBottom: 2 },
  checkInProgressStep: { flex: 1, gap: 6 },
  checkInProgressLine: { height: 3, borderRadius: 2, backgroundColor: palette.strong },
  checkInProgressLineActive: { backgroundColor: palette.door },
  checkInProgressLabel: { color: palette.faint, fontSize: 11, fontWeight: "600" },
  checkInProgressLabelActive: { color: palette.text },
  participantCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: palette.strong,
    borderRadius: 14,
    backgroundColor: palette.tile,
  },
  participantAvatar: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 26,
    backgroundColor: palette.door,
  },
  participantAvatarText: { color: palette.onDoor, fontSize: 21, fontWeight: "700" },
  participantCopy: { flex: 1, gap: 3 },
  participantName: {
    color: palette.text,
    fontSize: 20,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  participantClass: { color: palette.door, fontSize: 11, fontWeight: "700", letterSpacing: 1 },
  participantDetail: { color: palette.muted, fontSize: 13, lineHeight: 18 },
  identityReady: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: radius.tile,
    backgroundColor: "#15231B",
  },
  identityReadyCopy: { flex: 1, gap: 2 },
  identityReadyTitle: { color: palette.judging, fontSize: 15, fontWeight: "700" },
  identityReadyDetail: { color: palette.muted, fontSize: 13 },
});
