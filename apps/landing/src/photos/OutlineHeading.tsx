import { useEffect, useRef, useState } from "react";

/**
 * A page's heading drawn as stroked outline letters in the site's rose. A
 * letter fills with colour when the pointer crosses it (or a finger taps it)
 * and fades back over a second. Static otherwise: no filter, no motion.
 */
export function OutlineHeading({ word }: { word: string }) {
  const [lit, setLit] = useState<ReadonlySet<number>>(() => new Set());
  const timers = useRef(new Map<number, number>());
  useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
    },
    [],
  );

  const light = (index: number) => {
    setLit((current) => new Set(current).add(index));
    const existing = timers.current.get(index);
    if (existing !== undefined) window.clearTimeout(existing);
    timers.current.set(
      index,
      window.setTimeout(() => {
        timers.current.delete(index);
        setLit((current) => {
          const next = new Set(current);
          next.delete(index);
          return next;
        });
      }, 1_200),
    );
  };

  return (
    <h1 className="photos-outline-heading" aria-label={word}>
      {Array.from(word).map((letter, index) => (
        <span
          key={index}
          aria-hidden
          className={lit.has(index) ? "is-lit" : ""}
          onPointerEnter={() => light(index)}
          onPointerDown={() => light(index)}
        >
          {letter}
        </span>
      ))}
    </h1>
  );
}
