import { LiveNumber } from "../LiveNumber";
import { useState } from "react";

import { Reveal, Tile, TileEyebrow } from "./Tile";
import { hiddenWhenShort, tileBody } from "./tileClasses";
import type { Slot } from "./dashboardLayout";

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

function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      data-ph-sensitive
      onClick={() => void copy()}
      aria-label={copied ? "Benefit code copied" : "Copy benefit code"}
      className="flex h-7 max-w-full items-center gap-2 rounded-full border border-rose/55 bg-wash/45 px-3 font-mono text-[12px] tracking-[.06em] text-fg transition-colors hover:border-rose-light"
    >
      <span className="truncate">{code}</span>
      <span className="text-[10.5px] font-sans tracking-normal text-fg/55">{copied ? "copied" : "copy"}</span>
    </button>
  );
}

/** The benefits tile: the perks the team holds; a tap shows codes and links. */
export function BenefitsTile({ slot, model }: {
  slot: Slot; model: BenefitsTileModel }) {
  const [open, setOpen] = useState(false);
  const count = model.benefits.length;
  return (
    <Tile slot={slot} open={open && count > 0} onToggle={() => setOpen((value) => !value)}>
      <div className={tileBody}>
        <div className="flex items-baseline justify-between gap-3">
          <TileEyebrow>benefits</TileEyebrow>
          {count > 0 ? <span className="text-[11px] text-fg/50"><LiveNumber value={count} /> {count === 1 ? "perk" : "perks"}</span> : null}
        </div>
        {!model.available ? (
          <p className="m-0 text-[13px] leading-snug text-fg/65">Perks arrive once your place is confirmed.</p>
        ) : count === 0 ? (
          <p className="m-0 text-[13px] leading-snug text-fg/65">Nothing handed out yet. Codes and links land here.</p>
        ) : open ? (
          <Reveal key="codes" className="flex min-h-0 flex-col">
            {model.benefits.map((benefit) => (
              <div key={benefit.id} className="flex flex-col gap-1.5 border-b border-rose/20 py-2 last:border-b-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-[13px] text-fg">{benefit.name}</span>
                  {benefit.link ? (
                    <a href={benefit.link} target="_blank" rel="noreferrer" className="flex-none text-[11.5px] text-rose-light underline-offset-4 hover:underline">
                      open
                    </a>
                  ) : null}
                </div>
                {benefit.description ? (
                  <p className="m-0 text-[10.5px] leading-snug text-fg/50">{benefit.description}</p>
                ) : null}
                <CopyCode code={benefit.code} />
              </div>
            ))}
          </Reveal>
        ) : (
          <Reveal key="names" className="flex flex-col gap-1">
            <p className="m-0 line-clamp-2 font-display text-[19px] leading-tight text-shadow-[0_6px_30px_var(--scene-text-glow)]">
              {model.benefits.map((benefit) => benefit.name).join(" · ")}
            </p>
            <p className={`m-0 text-[12.5px] text-fg/65 ${hiddenWhenShort}`}>tap for codes</p>
          </Reveal>
        )}
      </div>
    </Tile>
  );
}
