import { LiveNumber } from "../LiveNumber";
import { Link } from "react-router-dom";

import { Tile, TileEyebrow } from "./Tile";
import { hiddenWhenShort, tileBody } from "./tileClasses";
import type { Slot } from "./dashboardLayout";

export type HelpTileModel = {
  discordUrl: string | null;
  /** Open support cases, or null when support is not available. */
  support: { open: number } | null;
};

const chip =
  "flex h-8 items-center gap-1.5 rounded-full border border-rose/55 bg-wash/45 px-3.5 text-[12.5px] font-semibold text-fg/85 backdrop-blur-md transition-colors hover:border-rose-light hover:text-fg";

/** The help tile: the three places to go, each one tap. */
export function HelpTile({ slot, model }: {
  slot: Slot; model: HelpTileModel }) {
  return (
    <Tile slot={slot} onToggle={() => {}}>
      <div className={tileBody}>
        <div className={hiddenWhenShort}>
          <TileEyebrow>help</TileEyebrow>
        </div>
        <div className="flex flex-wrap gap-2">
          {model.discordUrl ? (
            <a href={model.discordUrl} target="_blank" rel="noreferrer" className={chip}>
              Discord
            </a>
          ) : null}
          {model.support ? (
            <Link to="/support" viewTransition className={chip}>
              Support
              {model.support.open > 0 ? <span className="text-fg/55"><LiveNumber value={model.support.open} /></span> : null}
            </Link>
          ) : null}
          <Link to="/more" viewTransition className={chip}>
            More
          </Link>
        </div>
      </div>
    </Tile>
  );
}
