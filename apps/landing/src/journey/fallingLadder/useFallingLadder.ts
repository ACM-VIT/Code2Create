/*
 * Binds the FAQ act's simulation to the DOM.
 *
 * Measured, not authored: every position the solver needs is read off the page
 * as it already lays out — where the boughs sit, where each cord hangs, where
 * the rows would be if nothing had moved — so the act owns no geometry of its
 * own and the ladder ends it exactly on its own layout.
 *
 * Where a cord ties on is sampled out of the bough artwork. The plate is a
 * bitmap, so the underside of the limb is traced in limbCurve.js and the knot
 * goes at the y that trace gives for the cord's x. From then on the knot is a
 * point pinned to the limb: it turns and slides with it, and the ladder hangs
 * off wherever it has got to.
 *
 * The act plays once, in real time, when the journey arrives at it, and is
 * towed off through the frame's sides when the journey leaves it going the
 * other way. Neither is scrubbed
 * — a fall stepped through by a scroll wheel is not a fall — so this owns the
 * whole act, the boughs and the FAQ panel included: it shows them as the fall
 * begins and only hides them once the rope is home, which is what keeps the
 * reel on screen long enough to be seen.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import gsap from 'gsap';

import { limbAt } from '../limbCurve.js';
import {
  createLadderSim,
  createReelSim,
  FALL_TIME_SCALE,
  SIM_STEP,
  TIME_SCALE,
  type LadderAnchor,
  type LadderBough,
  type LadderColumn,
  type LadderSimulation,
  type LadderWorld,
} from './ladderPhysics.js';

/** Where a bough turns, as a fraction of its own box. Matches the artwork. */
const PIVOT_X = 0.04;
const PIVOT_Y = 0.12;

/** The longest real frame the solver will believe — a backgrounded tab. */
const MAX_FRAME = 0.1;

/*
 * Boxes are read against the stage's own rect rather than walked up the
 * offsetParent chain: the FAQ shell is centred with a translate, which offsets
 * cannot see, and the stage is sticky, so its rect moves under the scroll.
 * Nothing between here and the stage scales, so a pixel measured this way is
 * still a pixel of the `transform` and `left` written back onto a child.
 */
function boxWithin(el: HTMLElement, stageRect: DOMRect) {
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top - stageRect.top,
    left: rect.left - stageRect.left,
    width: rect.width,
    height: rect.height,
  };
}

/*
 * `remountKey` must change whenever the ladder's DOM is rebuilt — the phone
 * breakpoint remounts the columns, and an effect keyed only on the stage
 * kept measuring the detached old ones: fresh columns were never observed,
 * never pinned, and their ropes hung from nowhere after a live resize
 * across the breakpoint.
 */
export type LadderActivity = 'fall' | 'reel';

export function useFallingLadder(
  stageRef: RefObject<HTMLElement | null>,
  remountKey: boolean,
) {
  /* A stable handle: the effect hangs the real implementation off this ref, so
     the caller can hold the handle across re-runs without re-wiring anything,
     and calling it before the effect has run is simply ignored. */
  const cue = useRef<((on: boolean, immediate: boolean) => void) | null>(null);
  const setActive = useCallback(
    (on: boolean, immediate = false) => cue.current?.(on, immediate),
    [],
  );

  /* Same arrangement for asking: 'fall' or 'reel' while the act is still
     playing, null once it has settled or been struck. The journey holds its
     scroll at the act's doors on this. */
  const probe = useRef<(() => LadderActivity | null) | null>(null);
  const getBusy = useCallback(() => probe.current?.() ?? null, []);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;

    const boughEls = Array.from(stage.querySelectorAll<HTMLElement>('.bough'));
    const columnEls = Array.from(stage.querySelectorAll<HTMLElement>('.faq-column'));
    if (!boughEls.length || !columnEls.length) return undefined;

    const shellEl = stage.querySelector<HTMLElement>('.faq-shell');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let world: LadderWorld | null = null;
    let sim: LadderSimulation | null = null;
    /* 'rest' — off screen; 'fall' — being paid out; 'reel' — being hauled in. */
    let mode: 'rest' | LadderActivity = 'rest';
    let running = false;
    let wanted = false;

    /* The act's own curtain. The timeline hands the cue over and stays out of
       it, because when these go dark depends on the reel, which is real time
       and so cannot be a position on a scrubbed timeline. */
    const reveal = (on: boolean) => {
      const shown = shellEl ? [...boughEls, shellEl] : boughEls;
      shown.forEach((el) => {
        el.style.visibility = on ? 'visible' : 'hidden';
        el.style.opacity = on ? '1' : '0';
      });
    };

    const clearStyles = () => {
      boughEls.forEach((el) => {
        el.style.transform = '';
        el.style.transformOrigin = '';
      });
      columnEls.forEach((column) => {
        column.querySelectorAll<HTMLElement>('.plank').forEach((el) => {
          el.style.transform = '';
          el.style.transformOrigin = '';
        });
        column.querySelectorAll<HTMLElement>('.rope').forEach((el) => {
          el.style.left = '';
          el.style.right = '';
          el.style.top = '';
          el.style.height = '';
          el.style.transform = '';
          el.style.transformOrigin = '';
        });
      });
    };

    /* ---------------- measuring ---------------- */

    const measure = (): LadderWorld | null => {
      clearStyles();
      const stageRect = stage.getBoundingClientRect();

      const boughs: LadderBough[] = boughEls.map((el) => {
        const dir = el.dataset.boughSide === 'right' ? -1 : 1;
        const box = boxWithin(el, stageRect);
        return {
          el,
          dir,
          left: box.left,
          top: box.top,
          width: box.width,
          height: box.height,
          pivotX: (dir > 0 ? PIVOT_X : 1 - PIVOT_X) * box.width,
          pivotY: PIVOT_Y * box.height,
          delay: 0,
          angle: 0,
          angularV: 0,
          angularA: 0,
          entry: 0,
          load: 0,
          tx: 0,
          ty: 0,
          tvx: 0,
          tvy: 0,
          tax: 0,
          exitFrom: 0,
          exitTo: 0,
        };
      });

      /* The plate is still decoding — nothing can be placed off it yet. */
      if (boughs.some((bough) => bough.width < 1 || bough.height < 1)) return null;

      const columns: LadderColumn[] = [];
      columnEls.forEach((el) => {
        /* Dropped at this breakpoint: the second column goes on a phone. */
        if (el.offsetParent === null) return;

        const box = boxWithin(el, stageRect);
        const rungs = Array.from(el.querySelectorAll<HTMLElement>('.plank')).map((plank) => {
          const rung = boxWithin(plank, stageRect);
          return {
            el: plank,
            rest: rung.top,
            height: rung.height,
            span: 0,
            damping: 0,
            pos: rung.top,
            v: 0,
            taut: true,
          };
        });
        if (!rungs.length) return;

        const anchors: LadderAnchor[] = Array.from(el.querySelectorAll<HTMLElement>('.rope')).map((rope) => {
          const cord = boxWithin(rope, stageRect);
          const width = cord.width || 2.5;
          const worldX = cord.left + width / 2;
          const restX = worldX - box.left;

          /* Whichever bough covers this cord, and the lowest of them where two
             overlap — the ladder hangs off the limb in front. */
          let best: { bough: LadderBough; ay: number; y: number } | null = null;
          boughs.forEach((bough) => {
            if (worldX < bough.left || worldX > bough.left + bough.width) return;
            let t = (worldX - bough.left) / bough.width;
            if (bough.dir < 0) t = 1 - t;
            const under = limbAt(t);
            if (under == null) return;
            const ay = under * bough.height;
            if (!best || bough.top + ay > best.y) {
              best = { bough, ay, y: bough.top + ay };
            }
          });

          /* Past the end of every plate: tie to the nearest one rather than
             leave the cord hanging off nothing. */
          if (!best) {
            const bough = boughs.reduce((closest, candidate) => {
              const centre = candidate.left + candidate.width / 2;
              const rival = closest.left + closest.width / 2;
              return Math.abs(worldX - centre) < Math.abs(worldX - rival)
                ? candidate
                : closest;
            }, boughs[0]);
            const raw = Math.min(1, Math.max(0, (worldX - bough.left) / bough.width));
            const under = limbAt(bough.dir < 0 ? 1 - raw : raw) ?? 0.5;
            const ay = under * bough.height;
            best = { bough, ay, y: bough.top + ay };
          }

          return {
            el: rope,
            bough: best.bough,
            halfWidth: width / 2,
            restX,
            /* Where the knot sits in the bough's own unturned box. */
            ax: worldX - best.bough.left,
            ay: best.ay,
            /* Rewritten by the solver every step. */
            x: worldX,
            y: best.y,
            vy: 0,
            accX: 0,
            rx: 0,
          };
        });
        if (!anchors.length) return;

        const anchorRest = {
          x: anchors.reduce((sum, anchor) => sum + anchor.x, 0) / anchors.length,
          y: anchors.reduce((sum, anchor) => sum + anchor.y, 0) / anchors.length,
        };
        const last = rungs[rungs.length - 1];

        columns.push({
          el,
          left: box.left,
          top: box.top,
          rungs,
          anchors,
          anchorRest,
          /* Pendulum length for the sway: the knot down to the ladder's foot. */
          length: Math.max(120, last.rest + last.height - anchorRest.y),
          sway: 0,
          swayV: 0,
          anchorX: anchorRest.x,
          anchorY: anchorRest.y,
        });
      });

      if (!columns.length) return null;
      /* The pull-away needs to know where the frame's edges are, and which
         way to leave: tablets and phones roll the rig back up through the
         top, wider stages tow it out through the sides. Same breakpoint the
         CSS re-blocks the tablet composition at. */
      return {
        boughs,
        columns,
        stageWidth: stageRect.width,
        towUp: window.matchMedia('(max-width: 1100px)').matches,
      };
    };

    /* ---------------- drawing ---------------- */

    /* The cord is a 2.5px bar, so it is hung from the knot and turned to face
       the foot of the ladder rather than redrawn as a line. */
    const placeRope = (
      anchor: LadderAnchor,
      column: LadderColumn,
      endX: number,
      endY: number,
    ) => {
      const dx = endX - anchor.x;
      const dy = endY - anchor.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const el = anchor.el;
      el.style.right = 'auto';
      el.style.left = `${(anchor.x - column.left - anchor.halfWidth).toFixed(2)}px`;
      el.style.top = `${(anchor.y - column.top).toFixed(2)}px`;
      el.style.height = `${length.toFixed(2)}px`;
      el.style.transformOrigin = '50% 0';
      el.style.transform = `rotate(${Math.atan2(-dx, dy).toFixed(5)}rad)`;
    };

    /* Everything where the layout says it goes, with the cords strung between
       the knots and the foot of the ladder. This is also the finished pose. */
    const drawRest = () => {
      if (!world) return;
      world.boughs.forEach((bough) => {
        bough.el.style.transform = '';
        bough.el.style.transformOrigin = '';
      });
      world.columns.forEach((column) => {
        column.rungs.forEach((rung) => {
          rung.el.style.transform = '';
          rung.el.style.transformOrigin = '';
        });
        const last = column.rungs[column.rungs.length - 1];
        const foot = last.rest + last.height;
        column.anchors.forEach((anchor) => {
          anchor.x = anchor.bough.left + anchor.ax;
          anchor.y = anchor.bough.top + anchor.ay;
          placeRope(anchor, column, column.left + anchor.restX, foot);
        });
      });
    };

    const draw = () => {
      if (!world) return;
      world.boughs.forEach((bough) => {
        bough.el.style.transformOrigin = `${bough.pivotX.toFixed(2)}px ${bough.pivotY.toFixed(2)}px`;
        bough.el.style.transform = `translate(${bough.tx.toFixed(2)}px, ${bough.ty.toFixed(
          2,
        )}px) rotate(${(bough.dir * bough.angle).toFixed(5)}rad)`;
      });

      world.columns.forEach((column) => {
        /* The ladder's top goes where the knots have gone; everything below it
           trails by the swing, in proportion to how far below it hangs. The
           rungs lean with the rope but never turn with it — they carry text. */
        const shift = column.anchorX - column.anchorRest.x;
        const lean = Math.sin(column.sway);
        let foot = column.anchorY;

        column.rungs.forEach((rung) => {
          const centre = rung.pos + rung.height / 2;
          const x = shift + lean * Math.max(0, centre - column.anchorY);
          rung.el.style.transformOrigin = '50% 50%';
          rung.el.style.transform = `translate3d(${x.toFixed(2)}px, ${(
            rung.pos - rung.rest
          ).toFixed(2)}px, 0)`;
          if (rung.pos + rung.height > foot) foot = rung.pos + rung.height;
        });

        const footX = shift + lean * Math.max(0, foot - column.anchorY);
        column.anchors.forEach((anchor) => {
          placeRope(anchor, column, column.left + anchor.restX + footX, foot);
        });
      });
    };

    /* ---------------- running ---------------- */

    const stop = () => {
      if (running) {
        gsap.ticker.remove(tick);
        running = false;
      }
    };

    /* Wound back to before the act: measured, laid out, and dark. Whatever is
       drawn here is never seen, so it is the plain layout pose — the roll the
       fall starts from is built by the simulation itself. */
    const idle = () => {
      stop();
      sim = null;
      mode = 'rest';
      reveal(false);
      const measured = measure();
      world = measured;
      if (measured) drawRest();
    };

    function tick(_time: number, deltaMs: number) {
      if (!sim) return;
      const scale = mode === 'fall' ? FALL_TIME_SCALE : TIME_SCALE;
      let remaining = Math.min(deltaMs / 1000, MAX_FRAME) / scale;
      while (remaining > 0 && !sim.done) {
        sim.step(Math.min(remaining, SIM_STEP));
        remaining -= SIM_STEP;
      }
      draw();
      if (!sim.done) return;
      if (mode === 'reel') idle();
      else {
        stop();
        drawRest();
      }
    }

    const run = () => {
      running = true;
      gsap.ticker.add(tick);
    };

    const startFall = () => {
      stop();
      const measured = measure();
      if (!measured) return false;
      world = measured;
      sim = createLadderSim(world);
      mode = 'fall';
      reveal(true);
      if (reduced) {
        sim.finish();
        drawRest();
        return true;
      }
      /* One step before the first frame: the roll is built by the solver, not
         written down anywhere, so drawing straight off a fresh simulation
         would show the laid-out ladder for a frame and then snap it up. */
      sim.step(SIM_STEP);
      draw();
      run();
      return true;
    };

    /* Only a ladder that is out can be hauled back in; anything else has
       nothing to reel and simply goes dark. */
    const startReel = () => {
      if (!world || mode === 'rest' || reduced) return false;
      stop();
      sim = createReelSim(world);
      mode = 'reel';
      draw();
      run();
      return true;
    };

    cue.current = (on: boolean, immediate: boolean) => {
      if (immediate) {
        wanted = on;
        if (!on) {
          idle();
          return;
        }

        stop();
        const measured = measure();
        if (!measured) {
          wanted = false;
          return;
        }
        world = measured;
        sim = createLadderSim(world);
        mode = 'fall';
        reveal(true);
        sim.finish();
        drawRest();
        return;
      }

      if (on === wanted && (!on || sim !== null)) return;
      wanted = on;
      if (!on) {
        if (!startReel()) idle();
        return;
      }
      if (!startFall()) wanted = false;
    };

    /* `running` is true exactly while the ticker is stepping a simulation, so
       it is the whole of "still playing" for both directions. */
    probe.current = () => (running && mode !== 'rest' ? mode : null);

    idle();

    /*
     * The plates are large and still decoding when this first runs, and a
     * breakpoint change re-blocks the columns. Re-read whenever the page
     * settles into a different shape — but never mid-act, which would make the
     * ladder jump.
     */
    const relayout = () => {
      if (running) return;
      if (wanted) {
        if (sim === null) {
          if (!startFall()) wanted = false;
          return;
        }
        /* The act has already played and the rig is at rest. The old inline
           positions were measured against the old layout, so a resize used
           to leave the planks scattered across the new one — re-measure and
           pin the rig to its rest pose instead. */
        const measured = measure();
        if (!measured) return;
        world = measured;
        sim = createLadderSim(world);
        sim.finish();
        drawRest();
        return;
      }
      idle();
    };

    /* Trailing debounce for window/bough resizes. Accordion height is CSS:
       observing the columns used to remeasure the ropes against a half-open
       answer and hitch the ladder mid-tween. Relayout once the grid row has
       actually finished. */
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    const relayoutSettled = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(relayout, 160);
    };

    const onAnswerTransition = (event: TransitionEvent) => {
      if (event.propertyName !== 'grid-template-rows') return;
      relayout();
    };
    const answers = Array.from(stage.querySelectorAll<HTMLElement>('.plank__answer'));
    answers.forEach((el) => el.addEventListener('transitionend', onAnswerTransition));

    const observer = new ResizeObserver(relayoutSettled);
    boughEls.forEach((el) => observer.observe(el));
    window.addEventListener('resize', relayoutSettled);

    return () => {
      stop();
      clearTimeout(settleTimer);
      observer.disconnect();
      window.removeEventListener('resize', relayoutSettled);
      answers.forEach((el) => el.removeEventListener('transitionend', onAnswerTransition));
      cue.current = null;
      probe.current = null;
      clearStyles();
    };
  }, [stageRef, remountKey]);

  return useMemo(() => ({ setActive, getBusy }), [setActive, getBusy]);
}
