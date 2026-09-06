import { useCallback, useEffect, useId, useRef, useState } from "react";

import type { BenefitView } from "../dashboard/BenefitsTile";
import { useReducedMotion } from "../dashboard/useReducedMotion";
import { Petal } from "../portal/Petal";
import { PortalButton, PortalTextButton } from "../portal/PortalButton";
import { BenefitChest } from "./BenefitChest";
import { rememberBenefitReveal } from "./benefitReveal";
import "./benefit-redemption.css";

const petals = [
  ...Array.from({ length: 17 }, (_, index) => [
    { left: `${index * 6.25}%`, top: "0%", rotation: -52 + index * 19 },
    { left: `${index * 6.25}%`, top: "100%", rotation: 128 + index * 17 },
  ]).flat(),
  ...Array.from({ length: 9 }, (_, index) => [
    { left: "0%", top: `${10 + index * 10}%`, rotation: 208 + index * 23 },
    { left: "100%", top: `${10 + index * 10}%`, rotation: 32 + index * 21 },
  ]).flat(),
];

/** Reveals an existing grant. Vendor redemption remains on the benefit's own link. */
export function BenefitRedemption({ benefit, animate, onClose }: {
  benefit: BenefitView; animate: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const reducedMotion = useReducedMotion();
  const [revealed, setRevealed] = useState(!animate);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const ready = revealed || reducedMotion;
  const reveal = useCallback(() => setRevealed(true), []);

  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    if (ready) rememberBenefitReveal(benefit.id);
  }, [ready, benefit.id]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(benefit.code);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  };

  return <dialog ref={dialog} aria-labelledby={titleId} onClose={onClose}
    className="benefit-reveal" data-revealed={ready}>
    <button type="button" autoFocus aria-label="Close benefit" className="benefit-reveal__close"
      onClick={() => dialog.current?.close()}>×</button>
    {!ready ? <>
      <h2 id={titleId} className="sr-only">{benefit.name}</h2>
      <BenefitChest onComplete={reveal} />
      <PortalTextButton className="benefit-reveal__skip" onClick={reveal}>Show code now</PortalTextButton>
    </> : <div className="benefit-reveal__card">
      <div aria-hidden className="benefit-reveal__petals">
        {petals.map((petal, index) => <span key={index} style={{ left: petal.left, top: petal.top, rotate: `${petal.rotation}deg` }}>
          <Petal size={42 + index % 4 * 5} />
        </span>)}
      </div>
      <div className="benefit-reveal__details">
        <p className="benefit-reveal__scope">{benefit.scope === "team" ? "For your team" : "Just for you"}</p>
        <h2 id={titleId}>{benefit.name}</h2>
        {benefit.description ? <p className="benefit-reveal__description">{benefit.description}</p> : null}
        <p className="benefit-reveal__hint">{benefit.link ? "Copy your code, then redeem it with the provider." : "Your benefit code is ready to use."}</p>
        <code data-ph-sensitive className="benefit-reveal__code">{benefit.code}</code>
        <div className="benefit-reveal__actions">
          <PortalButton size="sm" variant="solid" onClick={() => void copy()}>{copyState === "copied" ? "Copied!" : "Copy code"}</PortalButton>
          {benefit.link ? <a href={benefit.link} target="_blank" rel="noopener noreferrer" className="benefit-reveal__redeem">Redeem benefit <span aria-hidden>↗</span></a> : null}
        </div>
        <p role="status" className="benefit-reveal__feedback">
          {copyState === "copied" ? "Code copied to clipboard." : copyState === "failed" ? "Couldn’t copy automatically. Select the code above to copy it." : ""}
        </p>
        <PortalTextButton onClick={() => dialog.current?.close()}>Back to benefits</PortalTextButton>
      </div>
    </div>}
  </dialog>;
}
