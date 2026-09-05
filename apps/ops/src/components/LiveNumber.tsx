import { RollingNumber, type RollingNumberProps } from "@kitlangton/rolling-number/react";
import "@kitlangton/rolling-number/styles.css";

const integerFormat = { useGrouping: false } satisfies Intl.NumberFormatOptions;

/** Shared motion and formatting for live operations metrics. */
export function LiveNumber({ format = integerFormat, ...props }: RollingNumberProps) {
  return <RollingNumber duration={350} format={format} {...props} />;
}
