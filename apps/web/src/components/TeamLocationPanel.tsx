import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";

import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { countdownName } from "../lib/time";

type LocationQr = {
  tokenId: FunctionReturnType<typeof api.floorParticipant.mintTeamQr>["tokenId"];
  payload: string;
  manualCode: string;
  expiresAt: number;
  serverNow: number;
  clientNow: number;
};

export function TeamLocationPanel() {
  const floor = useQuery(api.floorParticipant.current, { eventSlug });
  const mintTeamQr = useMutation(api.floorParticipant.mintTeamQr);
  const mintingRef = useRef(false);
  const [qr, setQr] = useState<LocationQr | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qrState = useQuery(
    api.floorParticipant.teamQrState,
    qr ? { eventSlug, tokenId: qr.tokenId } : "skip",
  );

  useEffect(() => {
    if (!qr) return;
    const timer = window.setInterval(() => {
      const nextNow = performance.now();
      setNow(nextNow);
      const nextServerNow = qr.serverNow + nextNow - qr.clientNow;
      if (nextServerNow >= qr.expiresAt) window.clearInterval(timer);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [qr]);

  if (floor === undefined) {
    return null;
  }
  if (!floor) return null;

  const qrServerNow = qr ? qr.serverNow + now - qr.clientNow : 0;
  const secondsLeft = qr ? Math.max(0, Math.ceil((qr.expiresAt - qrServerNow) / 1_000)) : 0;
  const tokenIsActive = qrState === undefined || qrState?.state === "active";
  const currentQr = floor.canMintQr && tokenIsActive && qr && secondsLeft > 0 ? qr : null;

  const showQr = async () => {
    if (!floor.canMintQr || mintingRef.current) return;
    mintingRef.current = true;
    setMinting(true);
    setError(null);
    try {
      const minted = await mintTeamQr({ eventSlug });
      const clientNow = performance.now();
      setQr({
        tokenId: minted.tokenId,
        payload: minted.payload,
        manualCode: minted.manualCode,
        expiresAt: minted.expiresAt,
        serverNow: minted.serverNow,
        clientNow,
      });
      setNow(clientNow);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      mintingRef.current = false;
      setMinting(false);
    }
  };

  return (
    <section className="attendance-panel" aria-labelledby="team-location-heading">
      <div>
        <p className="eyebrow">Team location</p>
        <h2 id="team-location-heading">
          {floor.location ? floor.location.description : "Waiting to be mapped"}
        </h2>
        <p className="muted review-queue-copy">
          {floor.location
            ? "This is roughly where staff recorded your team. Ask floor staff to rescan your code if you have moved."
            : "When floor staff reach your team, open this code for them. Nothing is attached to the table."}
        </p>
      </div>

      {currentQr ? (
        <div className="portal-qr">
          <div className="qr-surface">
            <QRCodeSVG
              bgColor="#f1eee8"
              fgColor="#0a0a09"
              level="M"
              marginSize={2}
              size={220}
              title="Short-lived team hall-location code"
              value={currentQr.payload}
            />
          </div>
          <p className="inline-status">
            Expires in {countdownName(secondsLeft)} · show this only to the floor-mapping team.
          </p>
          <p className="manual-code" aria-label={`Fallback code ${currentQr.manualCode}`}>
            {currentQr.manualCode}
          </p>
          <button
            className="text-button"
            type="button"
            disabled={minting}
            onClick={() => void showQr()}
          >
            {minting ? "Replacing…" : "Replace code"}
          </button>
        </div>
      ) : floor.canMintQr ? (
        <button className="primary" type="button" disabled={minting} onClick={() => void showQr()}>
          {minting ? "Creating code…" : qr ? "Refresh location code" : "Show location code"}
        </button>
      ) : null}

      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
