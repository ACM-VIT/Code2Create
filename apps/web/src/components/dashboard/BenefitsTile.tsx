import { LiveNumber } from "../LiveNumber";
import { useState } from "react";

import { BenefitRedemption } from "../benefits/BenefitRedemption";
import { hasRevealedBenefit } from "../benefits/benefitReveal";
import { Tile, TileEyebrow } from "./Tile";
import { tileBody } from "./tileClasses";
import type { Slot } from "./dashboardLayout";
import { useReducedMotion } from "./useReducedMotion";

export type BenefitView = {
  id: string;
  name: string;
  description?: string;
  link?: string;
  scope: "team" | "person";
  code: string;
};

export type BenefitsTileModel = {
  available: boolean;
  benefits: readonly BenefitView[];
};

/** Issued perks open a one-time chest reveal, then their real code and provider link. */
export function BenefitsTile({ slot, model }: {
  slot: Slot; model: BenefitsTileModel }) {
  const [selection, setSelection] = useState<{ id: string; animate: boolean } | null>(null);
  const reducedMotion = useReducedMotion();
  // Re-resolve from live grants so an archived/removed benefit cannot leave a stale modal.
  const selected = model.benefits.find(benefit => benefit.id === selection?.id);
  const count = model.benefits.length;
  return (
    <>
    <Tile slot={slot} open={selected !== undefined}>
      <div className={tileBody}>
        <div className="flex items-baseline justify-between gap-3">
          <TileEyebrow>benefits</TileEyebrow>
          <span className="text-[11px] text-fg/50"><LiveNumber value={count} /> {count === 1 ? "perk" : "perks"}</span>
        </div>
        <div className="flex min-h-0 flex-col gap-1">
          {model.benefits.map(benefit => <button key={benefit.id} type="button"
            aria-label={`Open ${benefit.name}`}
            onClick={event => setSelection({
              id: benefit.id,
              animate: event.detail !== 0 && !reducedMotion && !hasRevealedBenefit(benefit.id),
            })}
            className="flex min-h-12 w-full items-center gap-3 rounded-xl border-0 bg-transparent py-2 text-left text-fg transition-colors hover:bg-fg/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-light">
            <img src="/assets/magic-lucky-chest.webp" alt="" loading="lazy" className="h-11 w-12 shrink-0 object-contain" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-display text-[19px] leading-tight">{benefit.name}</span>
              <span className="text-[12px] text-fg/65">{hasRevealedBenefit(benefit.id) ? "View code & details" : "Reveal your benefit"}</span>
            </span>
            <span aria-hidden className="text-rose-light">↗</span>
          </button>)}
        </div>
      </div>
    </Tile>
    {selected && selection ? <BenefitRedemption key={selected.id} benefit={selected}
      animate={selection.animate} onClose={() => setSelection(null)} /> : null}
    </>
  );
}
