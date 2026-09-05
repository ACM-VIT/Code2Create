import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";

import { readableError } from "../../lib/errors";
import { LiveNumber } from "../LiveNumber";

export type TeamReviewCode = { payload: string; manualCode: string; expiresAt: number; serverNow: number };
export type TeamReviewCodeRequest = { sessionId: string; mint: () => Promise<TeamReviewCode> };

/** Open only on request, already scannable, with expiry based on the server clock. */
export function ReviewCode({ round, request, onClose }: { round: string; request: TeamReviewCodeRequest; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mint = useRef(request.mint);
  const [code, setCode] = useState<(TeamReviewCode & { receivedAt: number }) | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const secondsLeft = code ? Math.max(0, Math.ceil((code.expiresAt - code.serverNow - (now - code.receivedAt)) / 1_000)) : 0;
  const live = code && secondsLeft > 0 && !busy ? code : null;

  useEffect(() => { mint.current = request.mint; }, [request.mint]);
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    mint.current().then((minted) => {
      if (!cancelled) {
        const receivedAt = Date.now();
        setNow(receivedAt);
        setCode({ ...minted, receivedAt });
      }
    }).catch((caught: unknown) => {
      if (!cancelled) setError(readableError(caught));
    }).finally(() => {
      if (!cancelled) setBusy(false);
    });
    return () => { cancelled = true; };
  }, [attempt, request.sessionId]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <dialog ref={dialog} onClose={onClose} aria-labelledby="review-code-title" aria-describedby="review-code-help" className="m-auto max-h-[90dvh] w-[min(400px,calc(100vw-32px))] overflow-y-auto rounded-[22px] border border-petal-edge bg-wash p-6 font-ui text-fg shadow-2xl backdrop:bg-black/65 backdrop:backdrop-blur-sm">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="m-0 text-[11px] text-rose-light">{round}</p>
          <h2 id="review-code-title" className="m-0 mt-1 text-[22px] font-normal">Team review code</h2>
        </div>
        <button type="button" autoFocus aria-label="Close review code" onClick={() => dialog.current?.close()} className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border border-rose/35 bg-transparent text-lg text-fg/75 hover:border-rose-light focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-light">×</button>
      </header>
      <p id="review-code-help" className="m-0 mt-3 text-[13px] leading-relaxed text-fg/65">Let each reviewer scan this code to check in.</p>
      <div className="mt-5 flex min-h-64 flex-col items-center justify-center gap-4">
        {live ? <>
          <QRCodeSVG value={live.payload} size={256} marginSize={4} title="Team review code" className="h-auto w-full max-w-64 rounded-xl bg-white" />
          <p className="m-0 text-center font-mono text-[15px] tracking-wider">{live.manualCode}</p>
          <p className="m-0 text-[11px] text-fg/60">Valid for <LiveNumber value={secondsLeft} />s</p>
        </> : <>
          <p role="status" className="m-0 text-center text-[13px] text-fg/70">{busy ? "Making your code…" : error ?? "This code has expired."}</p>
          {!busy ? <button type="button" onClick={() => setAttempt((value) => value + 1)} className="cursor-pointer rounded-full border-0 bg-rose-light px-5 py-3 text-[13px] font-medium text-wash">{error ? "Try again" : "Get a new code"}</button> : null}
        </>}
      </div>
    </dialog>
  );
}
