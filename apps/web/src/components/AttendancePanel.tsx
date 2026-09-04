import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useAction, useQuery } from "convex/react";
import { QRCodeSVG } from "qrcode.react";
import { useRef, useState } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { AttendanceResultHistory } from "./AttendanceResultHistory";

type ExternalPass = {
  payload: string;
};

type ParticipantAttendance = FunctionReturnType<typeof api.attendanceParticipant.mine>;
type PhysicalCredential = ParticipantAttendance["physicalCredential"];
type VenueCheckIn = ParticipantAttendance["venueCheckIn"];
type VenueState = NonNullable<ParticipantAttendance["venue"]>["state"];
type SessionState = ParticipantAttendance["sessions"][number]["state"];

export function AttendancePanel() {
  const attendance = useQuery(api.attendanceParticipant.mine, { eventSlug });
  const loadExternalPass = useAction(api.attendanceActions.myExternalPass);
  const mintingRef = useRef(false);
  const [externalPass, setExternalPass] = useState<ExternalPass | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const showPass = async () => {
    if (!attendance?.canViewExternalPass || mintingRef.current) return;
    mintingRef.current = true;
    setMinting(true);
    setError(null);
    try {
      const next = await loadExternalPass({ eventSlug });
      setExternalPass({ payload: next.payload });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      mintingRef.current = false;
      setMinting(false);
    }
  };

  if (attendance === undefined) {
    return null;
  }
  if (!attendance.available) return null;

  const currentQr = attendance.canViewExternalPass ? externalPass : null;

  return (
    <section className="attendance-panel" aria-labelledby="attendance-heading">
      <div>
        <p className="eyebrow">At the event</p>
        <h2 id="attendance-heading">Check-in</h2>
      </div>
      <dl className="detail-list compact-details">
        <div>
          <dt>Event arrival</dt>
          <dd>{venueCheckInName(attendance.venueCheckIn)}</dd>
        </div>
        {attendance.venueCheckIn ? (
          <div>
            <dt>Current location</dt>
            <dd>{venueStateName(attendance.venue?.state ?? "not_arrived")}</dd>
          </div>
        ) : null}
        {attendance.sessions.map((session) => (
          <div key={session.id}>
            <dt>{session.timing === "current" ? session.name : `Next · ${session.name}`}</dt>
            <dd>
              {session.timing === "current"
                ? `${sessionStateName(session.state)} · ${session.zoneName}`
                : `${sessionTimeName(session.startsAt)} · ${session.zoneName}`}
            </dd>
          </div>
        ))}
        <div>
          <dt>
            {attendance.physicalCredential.kind === "vit_id_barcode"
              ? "VIT ID"
              : "External event pass"}
          </dt>
          <dd>{physicalCredentialName(attendance.physicalCredential)}</dd>
        </div>
      </dl>
      <p className="attendance-credential-note">
        {credentialInstruction(attendance.physicalCredential)}
      </p>
      {currentQr ? (
        <div className="portal-qr">
          <div className="qr-surface">
            <QRCodeSVG
              bgColor="#f1eee8"
              fgColor="#0a0a09"
              level="M"
              marginSize={2}
              size={220}
              title="Your Code2Create external participant event pass"
              value={currentQr.payload}
            />
          </div>
          <p className="inline-status">Static event pass · Show this only to event staff.</p>
          <button
            type="button"
            className="text-button"
            onClick={() => setExternalPass(null)}
          >
            Hide pass
          </button>
        </div>
      ) : attendance.canViewExternalPass ? (
        <button
          type="button"
          className="secondary"
          disabled={minting}
          onClick={() => void showPass()}
        >
          {minting ? "Loading pass…" : "Show event pass"}
        </button>
      ) : null}
      {attendance.canReadResultHistory ? <AttendanceResultHistory /> : null}
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function physicalCredentialName(credential: PhysicalCredential) {
  if (credential.kind === "vit_id_barcode") {
    if (credential.state === "active") return "Linked";
    if (credential.state === "suspended") return "Needs staff help";
    return "Link at first check-in";
  }
  if (credential.state === "active") return "Active";
  if (credential.state === "suspended") return "Suspended · ask event staff for help";
  return "Sent after acceptance";
}

function credentialInstruction(credential: PhysicalCredential) {
  if (credential.kind === "vit_id_barcode") {
    if (credential.state === "not_enrolled") {
      return "Bring your VIT ID. Staff will scan and link its printed barcode at your first check-in.";
    }
    if (credential.state === "active") {
      return "Bring your VIT ID. Staff scan its printed barcode when you enter or leave.";
    }
    return "Your VIT ID barcode is unavailable. Ask event staff to find you by registration number.";
  }
  if (credential.state === "active") {
    return "Show the static event pass from your email when staff record attendance.";
  }
  if (credential.state === "suspended") return "Ask event staff to restore your event pass.";
  return "Your personal event pass will be sent to your verified email.";
}

function venueStateName(state: VenueState) {
  if (state === "inside") return "Inside";
  if (state === "temporarily_out") return "Temporarily out";
  if (state === "departed") return "Departed";
  if (state === "unknown") return "Needs review";
  return "Not arrived";
}

function venueCheckInName(checkIn: VenueCheckIn) {
  if (!checkIn) return "Not checked in";
  if (checkIn.status === "reversed") return "Check-in reversed · see event staff";
  return `Checked in · ${new Date(checkIn.checkedInAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function sessionStateName(state: SessionState) {
  if (state === "confirmation_due") return "Confirmation due";
  if (state === "present") return "Present";
  if (state === "temporarily_out") return "Temporarily out";
  if (state === "complete") return "Complete";
  if (state === "excused") return "Excused";
  if (state === "needs_review") return "Needs review";
  return "Not expected";
}

function sessionTimeName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}
