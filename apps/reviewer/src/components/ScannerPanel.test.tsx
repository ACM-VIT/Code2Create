import { type ReactNode, useEffect } from "react";
import { CameraView } from "expo-camera";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ScannerPanel } from "./ScannerPanel";
import { DutyErrorBoundary } from "./DutyErrorBoundary";
import { enqueuePendingAttendanceScan } from "@/lib/pending-attendance-scans";

const state = vi.hoisted(() => ({
  registered: false,
  record: null as Record<string, unknown> | null,
  permission: { granted: true, canAskAgain: true },
  permissionFailure: false,
  focused: true,
  queryFailure: false,
  appListeners: new Set<(value: string) => void>(),
  action: vi.fn(), register: vi.fn(), heartbeat: vi.fn(), getCamera: vi.fn(), requestCamera: vi.fn(),
  captureException: vi.fn(), replace: vi.fn(),
}));
const device = {
  version: 1, installationId: "00000000-0000-4000-8000-000000000001",
  deviceSecret: "a".repeat(64), registrationOperationId: "00000000-0000-4000-8000-000000000002",
  deviceName: "Phone", platform: "ios", lastIssuedSequence: 0,
};
const assignment = {
  station: { id: "station", stableKey: "automatic_scanner", configurationVersion: 1,
    mode: "roving", allowedCredentialKinds: ["vit_id_barcode", "external_pass", "badge_qr"], barcodeSymbologies: ["code128"] },
  device: { id: "device", lastSequence: 0, pendingReplayCount: 0 },
  serverNow: 1788700000000, openSession: null, recentReceipts: [],
  offlinePolicy: { maxScans: 25, maxAgeSeconds: 300 },
};
vi.mock("@code2create/backend/api", () => ({ api: {
  attendanceScanner: { current: "current", history: "history" },
  attendanceActions: { registerDevice: "register", scannerHeartbeat: "heartbeat" },
  serviceQueues: { forStation: "queue" },
} }));
vi.mock("convex/react", () => ({
  useAction: (name: string) => name === "register" ? state.register : name === "heartbeat" ? state.heartbeat : state.action,
  useQuery: (name: string, args: object | "skip") => {
    if (args === "skip") return undefined;
    if (state.queryFailure) throw new Error("Query unavailable");
    return name === "current" ? (state.registered ? assignment : null) : null;
  },
  usePaginatedQuery: () => ({ results: [], status: "Exhausted", loadMore: vi.fn() }),
}));
vi.mock("expo-camera", () => ({ CameraView: "CameraView", Camera: {
  getCameraPermissionsAsync: state.getCamera, requestCameraPermissionsAsync: state.requestCamera,
} }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "operation" }));
vi.mock("expo-network", () => ({
  useNetworkState: () => ({ isConnected: true, isInternetReachable: true }),
  addNetworkStateListener: () => ({ remove: vi.fn() }),
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: "Screen" }, useLocalSearchParams: () => ({ task: "presence" }),
  useRouter: () => ({ setParams: vi.fn(), push: vi.fn(), replace: state.replace }),
  useFocusEffect: (effect: () => void | (() => void)) => {
    const focused = state.focused;
    useEffect(() => focused ? effect() : undefined, [effect, focused]);
  },
}));
vi.mock("posthog-react-native", () => ({ usePostHog: () => ({ captureException: state.captureException }) }));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: (_: string, listener: (value: string) => void) => {
    state.appListeners.add(listener); return { remove: () => state.appListeners.delete(listener) };
  } },
  Platform: { OS: "ios" }, Linking: { openSettings: vi.fn() },
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
  StyleSheet: { create: (value: object) => value, absoluteFill: {}, hairlineWidth: 1 },
  FlatList: "FlatList", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View",
}));
vi.mock("@/components/DutyIcon", () => ({ DutyIcon: "DutyIcon" }));
vi.mock("@/components/skeletons", () => ({ DoorSkeleton: "DoorSkeleton", CaseListSkeleton: "CaseListSkeleton" }));
vi.mock("@/components/ui", () => ({
  Action: "Action", Body: "Body", ChipRow: "ChipRow", Field: "Field", Heading: "Heading",
  HeaderButton: "HeaderButton", Meta: "Meta", Nothing: "Nothing", Problem: "Problem",
  QuietAction: "QuietAction", Row: "Row", Section: "Section", Sheet: "Sheet",
  ScanSurface: ({ camera, controls, result }: { camera: ReactNode; controls: ReactNode; result: ReactNode }) => <>{camera}{controls}{result}</>,
}));
vi.mock("@/lib/scanner-device", () => ({
  loadScannerDevice: async () => state.record,
  createScannerDevice: async () => { state.record = device; return device; },
  clearScannerDevice: async () => { state.record = null; },
  reserveDeviceSequence: async () => ({ ...device, lastIssuedSequence: 1 }),
}));
vi.mock("@/lib/client-operation-intents", () => ({
  usePersistentClientOperations: () => ({ records: new Map(), error: null, loading: false }),
  runPersistentClientOperation: vi.fn(),
}));
vi.mock("@/lib/pending-attendance-scans", () => ({
  clearPendingAttendanceScans: vi.fn(), enqueuePendingAttendanceScan: vi.fn(),
  loadPendingAttendanceScans: async () => [], pendingAttendanceSummary: async () => ({ count: 0 }),
  removePendingAttendanceScan: vi.fn(),
}));

let renderer: ReturnType<typeof create>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  state.registered = false; state.record = null; state.focused = true;
  state.permission = { granted: true, canAskAgain: true }; state.permissionFailure = false;
  state.queryFailure = false;
  state.register.mockImplementation(async () => { state.registered = true; });
  state.heartbeat.mockResolvedValue({ serverNow: assignment.serverNow });
  state.getCamera.mockImplementation(async () => {
    if (state.permissionFailure) throw new Error("Camera permission check failed");
    return state.permission;
  });
  state.requestCamera.mockImplementation(async () => {
    state.permission = { granted: true, canAskAgain: true }; return state.permission;
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  expect(state.appListeners.size).toBe(0);
});
async function start() {
  await act(async () => { renderer = create(<ScannerPanel eventSlug="test-event" />); });
  await act(async () => { renderer.root.findByProps({ label: "Start scanning" }).props.onPress(); });
}

test("first registration reaches the camera and heartbeat with no station selection", async () => {
  await start();
  expect(state.register).toHaveBeenCalledOnce();
  expect(state.register.mock.calls[0]?.[0]).not.toHaveProperty("stationId");
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(1);
  expect(state.heartbeat).toHaveBeenCalled();
});

test("camera permission errors offer retry and recover instead of an endless loading screen", async () => {
  state.permissionFailure = true;
  await start();
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(0);
  expect(JSON.stringify(renderer.toJSON())).toContain("Camera unavailable");
  state.permissionFailure = false;
  await act(async () => { await renderer.root.findByProps({ label: "Try camera again" }).props.onPress(); });
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(1);
});

test("camera mount failure shows retry, then mounts a fresh camera", async () => {
  await start();
  await act(async () => { renderer.root.findByType(CameraView).props.onMountError({ message: "Camera is busy" }); });
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(0);
  await act(async () => { await renderer.root.findByProps({ label: "Try camera again" }).props.onPress(); });
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(1);
});

test("denied camera access opens settings instead of requesting an impossible grant", async () => {
  state.permission = { granted: false, canAskAgain: false };
  await start();
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(0);
  expect(renderer.root.findByProps({ label: "Open Settings" })).toBeDefined();
});

test("camera releases on background and navigation, then resumes once focused", async () => {
  await start();
  await act(async () => { for (const listener of state.appListeners) listener("background"); });
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(0);
  await act(async () => { for (const listener of state.appListeners) listener("active"); });
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(1);
  state.focused = false;
  await act(async () => { renderer.update(<ScannerPanel eventSlug="test-event" />); });
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(0);
  state.focused = true;
  await act(async () => { renderer.update(<ScannerPanel eventSlug="test-event" />); });
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(1);
});

test("a failed duty offers retry and navigation without resetting the scanner", async () => {
  const retry = vi.fn().mockResolvedValue(undefined);
  const error = new Error("Query unavailable");
  await act(async () => { renderer = create(<DutyErrorBoundary error={error} retry={retry} />); });
  await act(async () => { await renderer.root.findByProps({ label: "Try again" }).props.onPress(); });
  expect(retry).toHaveBeenCalledOnce();
  await act(async () => { renderer.root.findByProps({ label: "Back to duties" }).props.onPress(); });
  expect(state.replace).toHaveBeenCalledWith("/");
  expect(state.captureException).toHaveBeenCalledWith(error, expect.objectContaining({ c2c_context: "duty" }));
});


test("a decoded card records once while busy and supports scanning the next person", async () => {
  state.action.mockResolvedValue({ outcome: "accepted", reasonCode: "venue_entry",
    serverTime: assignment.serverNow, participant: { displayName: "Test attendee" } });
  await start();
  const callback = renderer.root.findByType(CameraView).props.onBarcodeScanned;
  await act(async () => { await Promise.all([
    callback({ type: "code128", data: "26BDS0102" }),
    callback({ type: "code128", data: "26BDS0102" }),
  ]); });
  expect(state.action).toHaveBeenCalledOnce();
  expect(state.action).toHaveBeenCalledWith(expect.objectContaining({ rovingTransition: "venue_entry", movementReason: "general" }));
  expect(renderer.root.findByProps({ label: "Scan next" })).toBeDefined();
  await act(async () => { renderer.root.findByProps({ label: "Scan next" }).props.onPress(); });
  expect(renderer.root.findByType(CameraView).props.onBarcodeScanned).toBeTypeOf("function");
});

test("staff choose a departure reason before scanning and keep it for the next person", async () => {
  state.action.mockResolvedValue({ outcome: "accepted", reasonCode: "venue_exit_recorded",
    transition: "venue_exit", movementReason: "meal", serverTime: assignment.serverNow, participant: { displayName: "Dinner attendee" } });
  await start();
  await act(async () => { renderer.root.findByProps({ selected: "venue_entry" }).props.onSelect("venue_exit"); });
  expect(renderer.root.findAllByType(CameraView)).toHaveLength(0);
  expect(state.action).not.toHaveBeenCalled();
  await act(async () => { renderer.root.findByProps({ label: "Meal", detail: "Flexible return. No short-break timer." }).props.onPress(); });
  await act(async () => { await renderer.root.findByType(CameraView).props.onBarcodeScanned({ type: "code128", data: "26BDS0102" }); });
  expect(state.action).toHaveBeenCalledWith(expect.objectContaining({ rovingTransition: "venue_exit", movementReason: "meal" }));
  expect(enqueuePendingAttendanceScan).toHaveBeenCalledWith(expect.objectContaining({ input: expect.objectContaining({ rovingTransition: "venue_exit", movementReason: "meal" }) }));
  expect(JSON.stringify(renderer.toJSON())).not.toContain("capacity needs setup");
  await act(async () => { renderer.root.findByProps({ label: "Scan next" }).props.onPress(); });
  expect(renderer.root.findByProps({ selected: "venue_exit" })).toBeDefined();
  expect(renderer.root.findByProps({ label: "Meal", detail: "Tap to change reason" })).toBeDefined();
});

test("washroom departures send an explicit short-break reason and coming in never sends an exit", async () => {
  state.action.mockResolvedValue({ outcome: "accepted", reasonCode: "venue_exit_recorded", serverTime: assignment.serverNow, participant: null });
  await start();
  await act(async () => { renderer.root.findByProps({ selected: "venue_entry" }).props.onSelect("venue_exit"); });
  await act(async () => { renderer.root.findByProps({ label: "Washroom / short break", detail: "15-minute permission on departure; release the slot on return." }).props.onPress(); });
  await act(async () => { await renderer.root.findByType(CameraView).props.onBarcodeScanned({ type: "code128", data: "26BDS0102" }); });
  expect(state.action).toHaveBeenLastCalledWith(expect.objectContaining({ rovingTransition: "venue_exit", movementReason: "short_break" }));
  await act(async () => { renderer.root.findByProps({ label: "Scan next" }).props.onPress(); });
  await act(async () => { renderer.root.findByProps({ selected: "venue_exit" }).props.onSelect("venue_entry"); });
  await act(async () => { await renderer.root.findByType(CameraView).props.onBarcodeScanned({ type: "code128", data: "26BDS0102" }); });
  expect(state.action).toHaveBeenLastCalledWith(expect.objectContaining({ rovingTransition: "venue_entry" }));
});
