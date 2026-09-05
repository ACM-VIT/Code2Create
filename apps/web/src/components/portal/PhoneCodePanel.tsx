import { LiveNumber, LiveDuration } from "../LiveNumber";
import { CodeInput } from "./CodeInput";
import { PortalTickButton } from "./PortalButton";
import { PortalLabel } from "./PortalField";

/** Every verification state except `verified`, which the phone field shows itself. */
export type PhoneCodeState = "queued" | "sending" | "sent" | "send_failed" | "expired" | "locked";

/**
 * The row that opens under the phone field once a code has been texted: six
 * cells, a tick, and one reserved line that carries the expiry, the resend
 * countdown, or the error, so nothing below it moves.
 */
export function PhoneCodePanel({
  maskedPhone,
  state,
  canVerify,
  expiresInMs,
  resendInMs,
  code,
  onCodeChange,
  onVerify,
  onResend,
  busy,
  error,
  shakeKey,
}: {
  maskedPhone: string;
  state: PhoneCodeState;
  canVerify: boolean;
  expiresInMs: number | null;
  resendInMs: number;
  code: string;
  onCodeChange: (next: string) => void;
  onVerify: (code: string) => void;
  onResend: () => void;
  busy: boolean;
  error: string | null;
  shakeKey: number;
}) {
  const waiting = state === "queued" || state === "sending";
  const entryOpen = canVerify && !waiting && state !== "expired" && state !== "locked";
  const status = waiting
    ? "sending the text…"
    : state === "sent"
      ? expiresInMs !== null
        ? <>expires in <LiveDuration seconds={Math.max(0, Math.ceil(expiresInMs / 1000))} /></>
        : "check your messages"
      : state === "send_failed"
        ? canVerify
          ? "delivery wasn't confirmed · if the code arrived, it still works"
          : "the text couldn't be sent"
        : state === "expired"
          ? "that code expired"
          : "too many wrong attempts";
  const resend = waiting ? null : resendInMs > 0 ? (
    <span>resend in <LiveNumber value={Math.ceil(resendInMs / 1000)} />s</span>
  ) : (
    <button
      type="button"
      disabled={busy}
      onClick={onResend}
      className="rounded-sm text-rose-light transition-colors hover:underline disabled:cursor-not-allowed disabled:opacity-50"
    >
      {state === "sent" ? "send again" : "send a new code"}
    </button>
  );

  return (
    <div className="flex flex-col">
      <PortalLabel>
        code<span className="opacity-60"> · texted to {maskedPhone}</span>
      </PortalLabel>
      <div className="flex items-center gap-2.5">
        <CodeInput
          value={code}
          onChange={onCodeChange}
          onComplete={onVerify}
          disabled={!entryOpen || busy}
          label="Six-digit code from the text message"
          autoFocus
          shakeKey={shakeKey}
        />
        <PortalTickButton
          label={busy ? "Verifying…" : "Verify the code"}
          disabled={!entryOpen || busy || code.length !== 6}
          onClick={() => onVerify(code)}
        />
      </div>
      <p role="status" className="mt-1.5 min-h-[1lh] text-[11.5px] leading-snug text-fg/50">
        {error ? (
          <span role="alert" className="text-rose-light">
            {error}
          </span>
        ) : (
          status
        )}
        {resend ? <> · {resend}</> : null}
      </p>
    </div>
  );
}
