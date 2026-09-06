import { useEffect, useRef, useState } from "react";

export function BenefitChest({ onComplete }: { onComplete: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const art = useRef<HTMLImageElement>(null);
  const [mode, setMode] = useState<"loading" | "gpu" | "css">("loading");

  useEffect(() => {
    const element = canvas.current;
    const image = art.current;
    if (!element || !image) return;
    const controller = new AbortController();
    let dispose: (() => void) | null = null;
    const fallback = () => {
      if (controller.signal.aborted) return;
      controller.abort();
      dispose?.();
      setMode("css");
    };
    const startupTimer = window.setTimeout(fallback, 1_200);
    // A decorative renderer must never keep the code behind a stalled GPU.
    const deadline = window.setTimeout(onComplete, 5_000);
    void import("./benefitChestGpu").then(async ({ startBenefitChest }) => {
      if (controller.signal.aborted) return;
      dispose = await startBenefitChest({
        canvas: element, art: image, signal: controller.signal,
        onReady: () => { window.clearTimeout(startupTimer); setMode("gpu"); },
        onComplete, onFailure: fallback,
      });
      if (controller.signal.aborted) dispose?.();
      else if (!dispose) fallback();
    }).catch(fallback);
    return () => {
      window.clearTimeout(startupTimer);
      window.clearTimeout(deadline);
      controller.abort();
      dispose?.();
    };
  }, [onComplete]);

  useEffect(() => {
    if (mode !== "css") return;
    const timer = window.setTimeout(onComplete, 1_400);
    return () => window.clearTimeout(timer);
  }, [mode, onComplete]);

  return <div className={`benefit-chest benefit-chest--${mode}`} data-benefit-chest={mode}>
    <canvas ref={canvas} aria-hidden className="benefit-chest__canvas" />
    <img ref={art} src="/assets/magic-lucky-chest.webp" alt="" aria-hidden draggable={false}
      className="benefit-chest__art" onError={onComplete} />
    <p className="benefit-chest__caption" role="status">Opening your benefit…</p>
  </div>;
}
