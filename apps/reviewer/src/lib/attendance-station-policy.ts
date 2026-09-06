export const attendanceScanTransitions = [
  "venue_entry",
  "venue_exit",
  "session_confirm",
  "zone_entry",
  "zone_exit",
] as const;

export type ScanTransition = (typeof attendanceScanTransitions)[number];
export type AttendanceStationMode = ScanTransition | "roving";
export type AttendanceCredentialKind =
  "external_pass" | "badge_qr" | "vit_id_barcode";

export function allowedRovingTransitions(station: {
  mode: AttendanceStationMode;
  sessionId?: string;
  openSessionId?: string;
}): ScanTransition[] {
  if (station.mode !== "roving") return [];
  return station.sessionId === undefined ||
    station.openSessionId !== station.sessionId
    ? ["venue_entry", "venue_exit"]
    : [...attendanceScanTransitions];
}

export function stationAcceptsCredential(
  allowedCredentialKinds: readonly AttendanceCredentialKind[],
  credentialKind: AttendanceCredentialKind | "external_id_barcode",
) {
  return allowedCredentialKinds.includes(
    credentialKind === "external_id_barcode" ? "external_pass" : credentialKind,
  );
}

/** graVITas external cards print a GR registration barcode, not a VIT student ID. */
export function physicalCardKind(
  value: string,
): "vit_id_barcode" | "external_id_barcode" {
  return /^GR[0-9]{6,16}$/iu.test(value.trim())
    ? "external_id_barcode"
    : "vit_id_barcode";
}
