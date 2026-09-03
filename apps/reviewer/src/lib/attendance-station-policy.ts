export const attendanceScanTransitions = [
  "venue_entry",
  "venue_exit",
  "session_confirm",
  "zone_entry",
  "zone_exit",
] as const;

export type ScanTransition = (typeof attendanceScanTransitions)[number];
export type AttendanceStationMode = ScanTransition | "roving";
export type AttendanceCredentialKind = "portal_qr" | "badge_qr" | "vit_id_barcode";

export function allowedRovingTransitions(station: {
  mode: AttendanceStationMode;
  sessionId?: string;
  openSessionId?: string;
}): ScanTransition[] {
  if (station.mode !== "roving") return [];
  return station.sessionId === undefined || station.openSessionId !== station.sessionId
    ? ["venue_entry", "venue_exit"]
    : [...attendanceScanTransitions];
}

export function stationAcceptsCredential(
  allowedCredentialKinds: readonly AttendanceCredentialKind[],
  credentialKind: AttendanceCredentialKind,
) {
  return allowedCredentialKinds.includes(credentialKind);
}
