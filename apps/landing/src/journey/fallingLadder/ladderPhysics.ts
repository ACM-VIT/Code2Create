/*
 * The FAQ act, simulated rather than keyframed.
 *
 * A rolled rope ladder is strung on the blossom bough. The bough is hauled
 * back and pinned; the act lets go of it, and a beat later it lets go of the
 * roll. Nothing after that is scripted. Gravity pays the ladder out a rung at
 * a time — each cord hangs slack until the rung below it has fallen past, so
 * the release runs down the ladder rather than happening to it — and the last
 * cord to catch loads the whole rope at once. Rope is elastic, so that arrival
 * is stored rather than absorbed and comes straight back out: the ladder
 * recoils, bounces smaller, and settles onto the layout the CSS already
 * describes.
 *
 * Sideways is a second, separate pendulum. The two cords hang off two points
 * on the same limb, so the limb's swing carries the ladder's top with it while
 * the weight below lags. The rungs trail, but they stay level: a rung is a
 * plank of text, and text that rolls with the rope is unreadable, so the
 * ladder leans without ever turning.
 *
 * Scrolling back up tows the act away — see `createReelSim` at the foot of
 * this file, which drags each bough out through its own side of the frame
 * with the ladder trailing on the same cord physics.
 *
 * Rates and times below are in *simulation* seconds. The ticker feeds this
 * real time divided by TIME_SCALE, so the act plays out that much slower than
 * these numbers read on their own. Nothing else is touched — gravity,
 * stiffness and damping are what they were — which is what keeps the slowed
 * motion a real fall rather than a fall on a slow tape.
 *
 * No DOM in here: `world` is plain measured geometry, handed over by
 * useFallingLadder.js, and the solver writes its state back onto it.
 */

const DEG = Math.PI / 180;

export interface LadderBough {
  el: HTMLElement
  dir: number
  left: number
  top: number
  width: number
  height: number
  pivotX: number
  pivotY: number
  delay: number
  angle: number
  angularV: number
  angularA: number
  entry: number
  load: number
  tx: number
  ty: number
  tvx: number
  tvy: number
  tax: number
  exitFrom: number
  exitTo: number
}

export interface LadderAnchor {
  el: HTMLElement
  bough: LadderBough
  halfWidth: number
  restX: number
  ax: number
  ay: number
  x: number
  y: number
  vy: number
  accX: number
  rx: number
}

export interface LadderRung {
  el: HTMLElement
  rest: number
  height: number
  span: number
  damping: number
  pos: number
  v: number
  taut: boolean
}

export interface LadderColumn {
  el: HTMLElement
  left: number
  top: number
  rungs: LadderRung[]
  anchors: LadderAnchor[]
  anchorRest: { x: number; y: number }
  length: number
  sway: number
  swayV: number
  anchorX: number
  anchorY: number
}

export interface LadderWorld {
  boughs: LadderBough[]
  columns: LadderColumn[]
  stageWidth: number
  towUp: boolean
}

export interface LadderSimulation {
  readonly done: boolean
  finish(): void
  step(dt: number): void
}

/** Real seconds per simulation second — the reel's tape speed. */
export const TIME_SCALE = 0.95;

/** The fall runs twice as quick again: arriving must never feel like a wait. */
export const FALL_TIME_SCALE = 0.475;

/** Fixed solver step. The cords are stiff, so this sits well inside them. */
export const SIM_STEP = 1 / 600;

/** A backstop; the act is always over well inside this. */
const MAX_SIM_TIME = 5;

/* ---- the bough ------------------------------------------------------ */

/** How far back it is hauled before the act lets go. */
const BRANCH_PULL = 26 * DEG;
/** Natural frequency: one swing out and back every 0.58 sim seconds. */
const BRANCH_FREQ = 10.85;
/*
 * Damping ratio. Each swing returns at 18% of the one before it, so the bough
 * reads as exactly two full pendulum motions — a big one, then a small one —
 * and is still by the third.
 */
const BRANCH_DAMPING = 0.26;
/** The far bough is let go a beat after the near one. */
const BRANCH_STAGGER = 0.05;
/*
 * The bough also arrives: it starts up and outside the frame and slides into
 * place. That is a one-way settle rather than part of the swing, so it rides
 * the decay envelope on its own instead of the swinging cosine.
 */
const BRANCH_ENTRY_X = -0.08;
const BRANCH_ENTRY_Y = -0.46;

/*
 * The ladder tugs back on the limb it hangs from. Only the surplus over what
 * it weighs is passed on — the static droop is already in the artwork — so the
 * bough feels the snap when the rope goes taut and feels nothing at rest.
 */
const LOAD_GAIN = 2.4e-7;
const LOAD_CAP = 26000;

/* ---- the ladder ----------------------------------------------------- */

/** px/s². Stylised: real g at this scale would be off the screen in a blink. */
const GRAVITY = 2200;
/** Cord stiffness and damping, as a spring. This is where the recoil lives. */
const CORD_FREQ = 50;
const CORD_DAMPING = 0.46;
/** The bough is already swinging by the time the roll is dropped. */
const RELEASE_AT = 0.1;
/** How proud each rung sits in the roll before it is paid out. */
const STACK_GAP = 3;
/*
 * Air. Small enough that the fall is still a fall, big enough that the ladder
 * does not keep trading the same energy back and forth between rope and drop
 * long after the eye has stopped caring.
 */
const RUNG_DRAG = 0.6;

/* ---- sideways ------------------------------------------------------- */

const SWAY_FREQ = 18;
const SWAY_DAMPING = 0.45;
/** Cords cannot fold, and a lurching column of answers reads as broken. */
const MAX_SWAY = 5 * DEG;

/* ---- rest ----------------------------------------------------------- */

const REST_SPEED = 10; // px/s
const REST_OFFSET = 1; // px
const REST_ANGLE = 0.004; // rad

const BRANCH_W2 = BRANCH_FREQ * BRANCH_FREQ;
const BRANCH_C = 2 * BRANCH_DAMPING * BRANCH_FREQ;
const CORD_K = CORD_FREQ * CORD_FREQ;
const CORD_C = 2 * CORD_DAMPING * CORD_FREQ;
const SWAY_W2 = SWAY_FREQ * SWAY_FREQ;
const SWAY_C = 2 * SWAY_DAMPING * SWAY_FREQ;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/*
 * Where a point pinned to a bough has got to once the bough has turned and
 * slid, and the velocity and acceleration it carries. Rigid-body, so the
 * ladder hangs off the knot's real position rather than an estimate of it.
 */
function anchorAt(bough: LadderBough, anchor: LadderAnchor) {
  const phi = bough.dir * bough.angle;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = anchor.ax - bough.pivotX;
  const dy = anchor.ay - bough.pivotY;
  const rx = dx * cos - dy * sin;
  const ry = dx * sin + dy * cos;
  const phiV = bough.dir * bough.angularV;
  const phiA = bough.dir * bough.angularA;

  anchor.rx = rx;
  anchor.x = bough.left + bough.pivotX + rx + bough.tx;
  anchor.y = bough.top + bough.pivotY + ry + bough.ty;
  anchor.vy = phiV * rx + bough.tvy;
  anchor.accX = phiA * -ry - phiV * phiV * rx;
  return anchor;
}

export function createLadderSim(world: LadderWorld): LadderSimulation {
  const { boughs, columns } = world;

  boughs.forEach((bough, index) => {
    bough.delay = index * BRANCH_STAGGER;
    bough.angle = BRANCH_PULL;
    bough.angularV = 0;
    bough.angularA = 0;
    bough.entry = 1;
    bough.load = 0;
    bough.tx = BRANCH_ENTRY_X * bough.dir * bough.width;
    bough.ty = BRANCH_ENTRY_Y * bough.height;
    bough.tvy = 0;
  });

  columns.forEach((column) => {
    const count = column.rungs.length;

    column.rungs.forEach((rung, index) => {
      const above = index === 0 ? column.anchorRest.y : column.rungs[index - 1].rest;
      /*
       * A cord under load is already stretched where the ladder hangs still.
       * Take that stretch out of the unloaded length and the ladder comes to
       * rest exactly on the rows the CSS laid out, not a few pixels below them.
       */
      const load = count - index;
      const sag = (load * GRAVITY) / CORD_K;
      rung.span = Math.max(4, rung.rest - above - sag);
      /*
       * A cord high up the ladder is holding more than one below it, and a
       * spring damped for one rung barely touches six. Scale with the root of
       * what it carries and every cord is damped the same amount for its own
       * load, so the ladder settles as a ladder instead of the top of it
       * ringing on long after the foot has stopped.
       */
      rung.damping = CORD_C * Math.sqrt(load);
      rung.pos = rung.rest;
      rung.v = 0;
      rung.taut = true;
    });

    column.sway = 0;
    column.swayV = 0;
    column.anchorX = column.anchorRest.x;
    column.anchorY = column.anchorRest.y;
  });

  let time = 0;
  let released = false;
  let done = false;

  const stepBoughs = (dt: number) => {
    boughs.forEach((bough) => {
      const local = time - bough.delay;
      if (local <= 0) {
        bough.load = 0;
        return;
      }

      const accel = -BRANCH_W2 * bough.angle - BRANCH_C * bough.angularV + bough.load;
      bough.angularA = accel;
      bough.angularV += accel * dt;
      bough.angle += bough.angularV * dt;
      bough.load = 0;

      const entry = Math.exp(-BRANCH_C * local);
      bough.entry = entry;
      bough.tx = BRANCH_ENTRY_X * bough.dir * bough.width * entry;
      bough.ty = BRANCH_ENTRY_Y * bough.height * entry;
      bough.tvy = BRANCH_ENTRY_Y * bough.height * -BRANCH_C * entry;
    });
  };

  const stepColumn = (column: LadderColumn, dt: number) => {
    const anchors = column.anchors;
    const count = anchors.length;
    let midY = 0;
    let midVy = 0;
    let midAx = 0;
    let midX = 0;
    anchors.forEach((anchor) => {
      anchorAt(anchor.bough, anchor);
      midX += anchor.x;
      midY += anchor.y;
      midVy += anchor.vy;
      midAx += anchor.accX;
    });
    midX /= count;
    midY /= count;
    midVy /= count;
    midAx /= count;
    column.anchorX = midX;
    column.anchorY = midY;

    const rungs = column.rungs;
    const total = rungs.length;

    if (!released) {
      /* Rolled and still tied on: the roll goes wherever the limb goes. */
      rungs.forEach((rung, index) => {
        rung.pos = midY + index * STACK_GAP;
        rung.v = midVy;
        rung.taut = true;
      });
    } else {
      for (let index = 0; index < total; index += 1) {
        const rung = rungs[index];
        rung.v += (GRAVITY - RUNG_DRAG * rung.v) * dt;
      }

      for (let index = 0; index < total; index += 1) {
        const rung = rungs[index];
        const aboveY = index === 0 ? midY : rungs[index - 1].pos;
        const aboveV = index === 0 ? midVy : rungs[index - 1].v;
        const stretch = rung.pos - aboveY - rung.span;
        rung.taut = stretch > 0;
        if (!rung.taut) continue;

        /* Cord pulls and never pushes, so tension is clamped at zero. */
        const tension = Math.max(0, CORD_K * stretch + rung.damping * (rung.v - aboveV));
        rung.v -= tension * dt;

        if (index === 0) {
          const surplus = clamp(tension - total * GRAVITY, -LOAD_CAP, LOAD_CAP);
          anchors.forEach((anchor) => {
            anchor.bough.load +=
              (anchor.bough.dir * anchor.rx * surplus * LOAD_GAIN) / count;
          });
        } else {
          rungs[index - 1].v += tension * dt;
        }
      }

      for (let index = 0; index < total; index += 1) {
        rungs[index].pos += rungs[index].v * dt;
      }
    }

    /* Sideways: a pendulum whose pivot is being shaken by the bough. */
    const swayA =
      -SWAY_W2 * column.sway - SWAY_C * column.swayV - midAx / column.length;
    column.swayV += swayA * dt;
    let sway = column.sway + column.swayV * dt;
    if (sway > MAX_SWAY) {
      sway = MAX_SWAY;
      if (column.swayV > 0) column.swayV = 0;
    } else if (sway < -MAX_SWAY) {
      sway = -MAX_SWAY;
      if (column.swayV < 0) column.swayV = 0;
    }
    column.sway = sway;
  };

  const atRest = () => {
    if (time < RELEASE_AT + 0.3) return false;
    for (const bough of boughs) {
      if (Math.abs(bough.angle) > REST_ANGLE) return false;
      if (Math.abs(bough.angularV) > 0.08) return false;
      if (bough.entry > 0.01) return false;
    }
    for (const column of columns) {
      if (Math.abs(column.sway) > 0.003 || Math.abs(column.swayV) > 0.04) return false;
      for (const rung of column.rungs) {
        if (Math.abs(rung.pos - rung.rest) > REST_OFFSET) return false;
        if (Math.abs(rung.v) > REST_SPEED) return false;
      }
    }
    return true;
  };

  const finish = () => {
    boughs.forEach((bough) => {
      bough.angle = 0;
      bough.angularV = 0;
      bough.angularA = 0;
      bough.entry = 0;
      bough.tx = 0;
      bough.ty = 0;
      bough.tvy = 0;
      bough.load = 0;
    });
    columns.forEach((column) => {
      column.sway = 0;
      column.swayV = 0;
      column.anchors.forEach((anchor) => anchorAt(anchor.bough, anchor));
      column.anchorX = column.anchorRest.x;
      column.anchorY = column.anchorRest.y;
      column.rungs.forEach((rung) => {
        rung.pos = rung.rest;
        rung.v = 0;
        rung.taut = true;
      });
    });
    time = MAX_SIM_TIME;
    released = true;
    done = true;
  };

  return {
    get done() {
      return done;
    },
    finish,
    step(dt: number) {
      if (done) return;
      time += dt;
      if (!released && time >= RELEASE_AT) released = true;
      stepBoughs(dt);
      columns.forEach((column) => stepColumn(column, dt));
      if (time >= MAX_SIM_TIME || atRest()) finish();
    },
  };
}

/* ---- pulling away --------------------------------------------------- */

/*
 * Scrolling back up strikes the set. On a wide stage each bough is dragged
 * out through its own side of the frame — the left bough leaves stage left,
 * the right one stage right — and the ladder, still tied on, is towed along
 * with it. On a tablet or a phone (`world.towUp`) the rig is hauled straight
 * back up through the top instead: the boughs climb out and the ladder is
 * rolled up after them, which is the drop played in reverse rather than a
 * sideways strike there is no room for. Nothing about either tow is written
 * onto the rungs: the bough moves, the knots move with it, and the cords
 * pass that on exactly the way they did during the fall, so the ladder
 * trails its bough on its own physics until the whole rig is off screen.
 */

/** Sim seconds for a bough to clear the frame. Ends at full speed — yanked. */
const EXIT_TIME = 0.85;
/** Clears the edge with room for the ladder trailing at full lean. */
const EXIT_MARGIN = 90;
/*
 * The climb's own allowance. Hauled upward, the cords stretch under the
 * load and the foot of the ladder trails well behind the rest-length pose —
 * across a dozen cords the lag adds up — so the top exit clears by more
 * than the sideways one needs.
 */
const EXIT_CLEARANCE = 260;
/*
 * The tow's own pendulum. The fall's sway spring is far too stiff to show a
 * horizontal drag — the ladder would track its bough almost rigidly — so the
 * tow hangs the column on a softer one and lets it lean further.
 */
const EXIT_SWAY_FREQ = 6;
const EXIT_SWAY_DAMPING = 0.9;
const EXIT_MAX_SWAY = 10 * DEG;

const easeInQuad = (t: number) => t * t;

export function createReelSim(world: LadderWorld): LadderSimulation {
  const { boughs, columns, stageWidth, towUp } = world;

  /* Upward: high enough that the deepest-hanging ladder foot clears the top
     of the frame, elastic lag included. */
  const climb = towUp
    ? columns.reduce(
        (deep, column) => Math.max(deep, column.anchorRest.y + column.length),
        0,
      ) + EXIT_CLEARANCE
    : 0;

  boughs.forEach((bough) => {
    if (towUp) {
      bough.exitFrom = bough.ty;
      bough.exitTo = -climb;
    } else {
      bough.exitFrom = bough.tx;
      /* Out through its own edge: fully past the frame plus margin. */
      bough.exitTo =
        bough.dir > 0
          ? -(bough.left + bough.width + EXIT_MARGIN)
          : (stageWidth ?? bough.width * 2) - bough.left + EXIT_MARGIN;
    }
    bough.tvx = 0;
    bough.tax = 0;
  });

  /* The rungs keep whatever position and speed they had — a ladder pulled
     back mid-fall is towed away still falling. */

  const SWAY_EXIT_W2 = EXIT_SWAY_FREQ * EXIT_SWAY_FREQ;
  const SWAY_EXIT_C = 2 * EXIT_SWAY_DAMPING * EXIT_SWAY_FREQ;

  let time = 0;
  let done = false;

  const finish = () => {
    done = true;
  };

  return {
    get done() {
      return done;
    },
    finish,
    step(dt: number) {
      if (done) return;
      time += dt;
      const drawn = easeInQuad(Math.min(1, time / EXIT_TIME));

      boughs.forEach((bough) => {
        const at = bough.exitFrom + (bough.exitTo - bough.exitFrom) * drawn;
        if (towUp) {
          /* The climb feeds the cords through tvy — anchorAt carries it into
             each knot's velocity — and shakes nothing sideways. */
          bough.tvy = (at - bough.ty) / dt;
          bough.ty = at;
          bough.tax = 0;
        } else {
          const tvx = (at - bough.tx) / dt;
          bough.tax = (tvx - bough.tvx) / dt;
          bough.tvx = tvx;
          bough.tx = at;
        }
      });

      columns.forEach((column) => {
        const anchors = column.anchors;
        const count = anchors.length;
        let midY = 0;
        let midVy = 0;
        let midAx = 0;
        let midX = 0;
        anchors.forEach((anchor) => {
          anchorAt(anchor.bough, anchor);
          midX += anchor.x;
          midY += anchor.y;
          midVy += anchor.vy;
          /* The knot carries the tow's acceleration as well as the swing's. */
          midAx += anchor.accX + anchor.bough.tax;
        });
        midX /= count;
        midY /= count;
        midVy /= count;
        midAx /= count;
        column.anchorX = midX;
        column.anchorY = midY;

        /* The cords, verbatim from the fall: hanging is hanging. */
        const rungs = column.rungs;
        const total = rungs.length;
        for (let index = 0; index < total; index += 1) {
          const rung = rungs[index];
          rung.v += (GRAVITY - RUNG_DRAG * rung.v) * dt;
        }
        for (let index = 0; index < total; index += 1) {
          const rung = rungs[index];
          const aboveY = index === 0 ? midY : rungs[index - 1].pos;
          const aboveV = index === 0 ? midVy : rungs[index - 1].v;
          const stretch = rung.pos - aboveY - rung.span;
          rung.taut = stretch > 0;
          if (!rung.taut) continue;
          const tension = Math.max(0, CORD_K * stretch + rung.damping * (rung.v - aboveV));
          rung.v -= tension * dt;
          if (index > 0) rungs[index - 1].v += tension * dt;
        }
        for (let index = 0; index < total; index += 1) {
          rungs[index].pos += rungs[index].v * dt;
        }

        const swayA =
          -SWAY_EXIT_W2 * column.sway - SWAY_EXIT_C * column.swayV - midAx / column.length;
        column.swayV += swayA * dt;
        let sway = column.sway + column.swayV * dt;
        if (sway > EXIT_MAX_SWAY) {
          sway = EXIT_MAX_SWAY;
          if (column.swayV > 0) column.swayV = 0;
        } else if (sway < -EXIT_MAX_SWAY) {
          sway = -EXIT_MAX_SWAY;
          if (column.swayV < 0) column.swayV = 0;
        }
        column.sway = sway;
      });

      if (time >= EXIT_TIME) finish();
    },
  };
}
