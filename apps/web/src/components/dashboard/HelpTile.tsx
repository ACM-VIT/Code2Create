import { Link } from "react-router-dom";

import { Tile, TileEyebrow } from "./Tile";

export type HelpTileModel = {
  discordUrl: string | null;
  /** Open support cases, or null when support is not available. */
  support: { open: number } | null;
};

const row =
  "flex items-center justify-between gap-3 border-b border-rose/20 py-2 text-[13px] text-fg/85 transition-colors last:border-b-0 hover:text-rose-light";

/** The help tile: the three places to go, each one tap. */
export function HelpTile({ model }: { model: HelpTileModel }) {
  return (
    <Tile area="help" onToggle={() => {}}>
      <div className="flex flex-1 flex-col justify-between gap-2 p-[18px]">
        <TileEyebrow>help</TileEyebrow>
        <div className="flex flex-col">
          {model.discordUrl ? (
            <a href={model.discordUrl} target="_blank" rel="noreferrer" className={row}>
              <span>Discord</span>
              <span className="text-[11px] text-fg/45">opens in a tab</span>
            </a>
          ) : null}
          {model.support ? (
            <Link to="/support" viewTransition className={row}>
              <span>Support</span>
              <span className="text-[11px] text-fg/45">
                {model.support.open > 0 ? `${model.support.open} open` : "ask the desk"}
              </span>
            </Link>
          ) : null}
          <Link to="/more" viewTransition className={row}>
            <span>More</span>
            <span className="text-[11px] text-fg/45">profile, notifications</span>
          </Link>
        </div>
      </div>
    </Tile>
  );
}
