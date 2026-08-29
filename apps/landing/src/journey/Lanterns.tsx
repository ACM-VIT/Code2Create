import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

/*
 * The four stat lanterns.
 *
 * They blow in from the left on a strong wind and settle like hot-air
 * balloons: carried horizontally, buoyant vertically, always lagging the gust
 * a little. The master timeline drives the entrance (it targets `.lantern`);
 * everything here is the live behaviour — the buoyant bob, the flame flicker,
 * and a slight lean toward the cursor when you hover near one.
 */

/* `from` is where the lantern enters from, as a % of the stage, and `x/y` is
   where it comes to rest. Heights are chosen so each lamp *and* its caption
   clear the front ridge. `phone` is the staggered two-column arrangement
   from the design's mobile frame — lamps at half the size they first
   shipped at, the 7th-edition one still the largest, captions stacked
   beneath; x is shifted so each column keeps its old centre line. */
export const LANTERNS = [
  { art: '/assets/svg/lantern-4.svg', value: '2000+', label: 'Participants', x: 54, y: 13, size: 8.4, from: -46, drop: 16, phone: { x: 17, y: 46, size: 13 } },
  { art: '/assets/svg/lantern-1.svg', value: '7th', label: 'Edition', x: 17, y: 22, size: 11.6, from: -34, drop: 22, phone: { x: 16, y: 11, size: 19 } },
  { art: '/assets/svg/lantern-3.svg', value: '25+', label: 'Past Sponsors', x: 76, y: 30, size: 8.6, from: -58, drop: 12, phone: { x: 69, y: 65.5, size: 13 } },
  { art: '/assets/svg/lantern-2.svg', value: '250+', label: 'Projects', x: 36, y: 40, size: 8.4, from: -42, drop: 18, phone: { x: 66.5, y: 31, size: 13 } },
];

/** The spec as it applies at the given breakpoint. */
export const lanternAt = (index: number, phone: boolean) =>
  phone && LANTERNS[index].phone
    ? { ...LANTERNS[index], ...LANTERNS[index].phone }
    : LANTERNS[index];

const PULL = 22; // px the lantern leans toward the pointer at closest range
const REACH = 240; // px radius the pointer starts to attract from

interface LanternsProps {
  stageRef: RefObject<HTMLElement | null>
}

interface LanternStyle extends CSSProperties {
  '--flicker': string
  '--flicker-delay': string
  '--bob': string
}

export default function Lanterns({ stageRef }: LanternsProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches,
  );

  useEffect(() => {
    const query = window.matchMedia('(max-width: 760px)');
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    const root = rootRef.current;
    if (!stage || !root) return undefined;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const nodes = Array.from(root.querySelectorAll<HTMLElement>('.lantern__follow'));
    const state = nodes.map(() => ({ x: 0, y: 0, tx: 0, ty: 0 }));
    const pointer = { x: -9999, y: -9999, inside: false };

    const onMove = (event: PointerEvent) => {
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      pointer.inside = true;
    };
    const onLeave = () => {
      pointer.inside = false;
    };

    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerleave', onLeave);

    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);

      nodes.forEach((node, index) => {
        const s = state[index];

        if (pointer.inside) {
          const box = node.getBoundingClientRect();
          /* Aim at the envelope rather than the caption underneath it. */
          const cx = box.left + box.width / 2;
          const cy = box.top + box.height * 0.32;
          const dx = pointer.x - cx;
          const dy = pointer.y - cy;
          const dist = Math.hypot(dx, dy);

          if (dist < REACH && box.width > 0) {
            const strength = (1 - dist / REACH) ** 1.6;
            s.tx = (dx / (dist || 1)) * PULL * strength;
            s.ty = (dy / (dist || 1)) * PULL * strength;
          } else {
            s.tx = 0;
            s.ty = 0;
          }
        } else {
          s.tx = 0;
          s.ty = 0;
        }

        /* A balloon has mass — it eases toward the target, never snaps. */
        s.x += (s.tx - s.x) * 0.05;
        s.y += (s.ty - s.y) * 0.05;

        if (Math.abs(s.x) > 0.02 || Math.abs(s.y) > 0.02) {
          node.style.transform = `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, 0)`;
        } else {
          node.style.transform = '';
        }
      });
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerleave', onLeave);
    };
  }, [stageRef]);

  return (
    <div className="lanterns" ref={rootRef}>
      {LANTERNS.map((base, index) => {
        const lantern = lanternAt(index, narrow);
        const style: LanternStyle = {
          left: `${lantern.x}%`,
          top: `${lantern.y}%`,
          width: `${lantern.size}%`,
          '--flicker': `${(3.1 + index * 0.83).toFixed(2)}s`,
          '--flicker-delay': `${(index * -1.37).toFixed(2)}s`,
          '--bob': `${(7.5 + index * 1.6).toFixed(2)}s`,
        };
        return (
        <div
          className="lantern"
          key={base.label}
          data-from={lantern.from}
          data-drop={lantern.drop}
          style={style}
        >
          <div className="lantern__bob">
            <div className="lantern__follow">
              <span className="lantern__glow" aria-hidden="true" />
              <img className="lantern__body" src={lantern.art} alt="" />
              <span className="lantern__beam" aria-hidden="true" />
              <p className="lantern__label">
                <span className="lantern__value">{lantern.value}</span>
                <span>{lantern.label}</span>
              </p>
            </div>
          </div>
        </div>
        );
      })}
    </div>
  );
}

/** Thin streaks that make the gust legible without drawing attention. */
export function Wind() {
  /* Long, faint and slow — a gust reads as streaks you half-notice, not as
     dashes drawn across the frame. */
  const lines = [
    { top: 14, width: 62, duration: 6.4, delay: 0, opacity: 0.2 },
    { top: 23, width: 44, duration: 8.2, delay: -2.1, opacity: 0.12 },
    { top: 37, width: 74, duration: 5.6, delay: -3.4, opacity: 0.17 },
    { top: 48, width: 50, duration: 9.1, delay: -1.2, opacity: 0.1 },
    { top: 58, width: 66, duration: 7.0, delay: -4.6, opacity: 0.15 },
    { top: 68, width: 38, duration: 10.2, delay: -0.6, opacity: 0.09 },
    { top: 31, width: 56, duration: 7.4, delay: -5.3, opacity: 0.13 },
    { top: 78, width: 48, duration: 8.6, delay: -3.1, opacity: 0.08 },
  ];

  return (
    <div className="wind" aria-hidden="true">
      {lines.map((line, index) => (
        <span
          key={index}
          className="wind__line"
          style={{
            top: `${line.top}%`,
            width: `${line.width}%`,
            opacity: line.opacity,
            animationDuration: `${line.duration}s`,
            animationDelay: `${line.delay}s`,
          }}
        />
      ))}
    </div>
  );
}
