import { useEffect, useState } from "react";

/*
 * The blossom boughs across the top of the FAQ act.
 *
 * On wide stages there are two, as there always were: the supplied plate on
 * the left and the same bitmap mirrored on the right, one over each column
 * of the ladder. Where a rope ties on is read from `limbCurve.js`.
 *
 * Phones follow the design's mobile frame instead: ONE branch spanning the
 * whole top, carrying both ropes of the single column. The second entry
 * there is a GHOST — an invisible box parked past the frame's edge so it
 * covers no rope and simply keeps the simulation's pair intact.
 */

interface BoughLayout {
  side: "left" | "right";
  left: number;
  top: number;
  width: number;
  ghost?: boolean;
}

const WIDE: readonly BoughLayout[] = [
  { side: "left", left: -8, top: -14, width: 60 },
  { side: "right", left: 48, top: -16, width: 60 },
];

const NARROW: readonly BoughLayout[] = [
  /* Full width, always: the plate must reach the far rope, whatever the
     aspect. The shell's top tracks the plate's height (46vw) instead, so a
     wide-but-short window pushes the ladder down rather than shrinking the
     branch. */
  { side: "left", left: -4, top: -2, width: 108 },
  { side: "right", left: 120, top: -26, width: 40, ghost: true },
];

export default function Branches() {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const boughs = narrow ? NARROW : WIDE;

  return (
    <div className="branches" aria-hidden="true">
      {boughs.map((bough) => (
        <div
          className={`bough bough--${bough.side}${bough.ghost === true ? " bough--ghost" : ""}`}
          key={bough.side}
          data-bough-side={bough.side}
          style={{ left: `${bough.left}%`, top: `${bough.top}%`, width: `${bough.width}%` }}
        >
          {bough.ghost !== true && <img src="/assets/img/branch-plate.png" alt="" />}
        </div>
      ))}
    </div>
  );
}
