import { RollingNumber, type RollingNumberProps } from "@kitlangton/rolling-number/react";
import "@kitlangton/rolling-number/styles.css";

const integerFormat = { useGrouping: false } satisfies Intl.NumberFormatOptions;
const clockFormat = { useGrouping: false, minimumIntegerDigits: 2 } satisfies Intl.NumberFormatOptions;

/** Shared motion and formatting for numbers that change while the page is open. */
export function LiveNumber({ format = integerFormat, ...props }: RollingNumberProps) {
  return <RollingNumber duration={350} format={format} {...props} />;
}

/** Keep clock units separate so each tick preserves its place and leading zeroes. */
export function LiveDuration({ seconds, hours = false }: { seconds: number; hours?: boolean }) {
  const total = Math.max(0, Math.floor(seconds));
  return (
    <span className="tabular-nums whitespace-nowrap">
      {hours ? <><LiveNumber value={Math.floor(total / 3600)} format={clockFormat} />:</> : null}
      <LiveNumber value={hours ? Math.floor(total / 60) % 60 : Math.floor(total / 60)} format={hours ? clockFormat : integerFormat} />:
      <LiveNumber value={total % 60} format={clockFormat} />
    </span>
  );
}

const elapsedFormat = { useGrouping: false, minimumFractionDigits: 1, maximumFractionDigits: 1 } satisfies Intl.NumberFormatOptions;

export function LiveElapsed({ milliseconds }: { milliseconds: number }) {
  const seconds = milliseconds / 1000;
  return (
    <span className="whitespace-nowrap">
      {seconds >= 60 ? <><LiveNumber value={Math.floor(seconds / 60)} />m </> : null}
      <LiveNumber value={seconds < 60 ? seconds : seconds % 60} format={elapsedFormat} duration={100} />s
    </span>
  );
}
