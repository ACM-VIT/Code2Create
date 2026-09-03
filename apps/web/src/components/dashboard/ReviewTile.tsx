import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";

import { readableError } from "../../lib/errors";
import { PortalButton } from "../portal/PortalButton";
import { Reveal, Tile, TileEyebrow } from "./Tile";

export type LocationCode = {
  payload: string;
  manualCode: string;
  expiresAt: number;
  serverNow: number;
};

export type ReviewTileModel = {
  available: boolean;
  /** Where staff last recorded the team, once mapped. */
  location: string | null;
  queue: { round: string; state: string; detail?: string } | null;
  /** Mints a short-lived code for the floor team; absent when not allowed. */
  showLocationCode: (() => Promise<LocationCode>) | null;
};

function useSecondsLeft(code: LocationCode | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!code) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [code]);
  if (!code) return 0;
  const serverNow = code.serverNow + (now - code.serverNow);
  return Math.max(0, Math.ceil((code.expiresAt - serverNow) / 1_000));
}

/**
 * The review tile: the team's place in the round and where it sits in the
 * hall. A tap offers the location code, which appears in the card itself.
 */
export function ReviewTile({ model }: { model: ReviewTileModel }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<LocationCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const secondsLeft = useSecondsLeft(code);
  const liveCode = code && secondsLeft > 0 ? code : null;

  const mint = async () => {
    if (!model.showLocationCode) return;
    setBusy(true);
    setError(null);
    try {
      setCode(await model.showLocationCode());
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Tile area="queue" open={open} onToggle={() => setOpen((value) => !value)}>
      <div className="flex flex-1 flex-col justify-between gap-3 p-[18px]">
        <div className="flex items-baseline justify-between gap-3">
          <TileEyebrow>review</TileEyebrow>
          {model.queue ? <span className="text-[11px] text-fg/50">{model.queue.round}</span> : null}
        </div>
        {!model.available ? (
          <p className="m-0 text-[13px] leading-snug text-fg/65">
            Reviews open once your place is confirmed.
          </p>
        ) : open && liveCode ? (
          <Reveal key="code" className="flex items-center gap-4">
            <span className="flex-none rounded-[10px] bg-[#f1eee8] p-1.5">
              <QRCodeSVG
                bgColor="#f1eee8"
                fgColor="#0a0a09"
                level="M"
                marginSize={0}
                size={92}
                value={liveCode.payload}
                title="Team location code"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-mono text-[15px] tracking-[.08em] text-fg">
                {liveCode.manualCode}
              </span>
              <span className="block text-[11.5px] text-fg/55">
                for the floor team · {secondsLeft}s left
              </span>
              <button
                type="button"
                onClick={() => setCode(null)}
                className="mt-1 text-[12px] text-rose-light underline-offset-4 hover:underline"
              >
                hide
              </button>
            </span>
          </Reveal>
        ) : (
          <Reveal key={open ? "open" : "summary"} className="flex flex-col gap-2.5">
            <div>
              <p className="m-0 font-display text-[19px] leading-tight text-shadow-[0_6px_30px_var(--scene-text-glow)]">
                {model.queue ? model.queue.state : "No review round yet"}
              </p>
              <p className="m-0 text-[12.5px] text-fg/65">
                {model.queue?.detail ?? model.location ?? "Waiting to be mapped in the hall."}
              </p>
              {model.queue?.detail && model.location ? (
                <p className="m-0 text-[12.5px] text-fg/55">{model.location}</p>
              ) : null}
            </div>
            {open && model.showLocationCode ? (
              <div className="flex items-center gap-3">
                <PortalButton size="sm" variant="solid" disabled={busy} onClick={() => void mint()}>
                  {busy ? "Making a code…" : "Show location code"}
                </PortalButton>
                {error ? <span className="text-[12px] text-rose-light">{error}</span> : null}
              </div>
            ) : null}
          </Reveal>
        )}
      </div>
    </Tile>
  );
}
