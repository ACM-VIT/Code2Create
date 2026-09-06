/**
 * The colour maths behind the matching game.
 *
 * A guess is scored on how close it looks, not on how close its numbers are:
 * two colours a few degrees apart in hue can be indistinguishable in one part
 * of the wheel and obviously different in another. The comparison happens in
 * OKLab, where a step of the same size looks like the same size wherever it is
 * taken, so the score matches what the eye reports.
 */

export type HsvColor = { readonly hue: number; readonly saturation: number; readonly value: number };
export type OklabColor = { readonly L: number; readonly a: number; readonly b: number };

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** HSV (0-360, 0-100, 0-100) to sRGB (0-1). */
export function hsvToRgb({ hue, saturation, value }: HsvColor): [number, number, number] {
  const s = clamp(saturation, 0, 100) / 100;
  const v = clamp(value, 0, 100) / 100;
  const h = ((hue % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b]: [number, number, number] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** sRGB (0-1) to OKLab, the space the scoring compares in. */
export function rgbToOklab(r: number, g: number, b: number): OklabColor {
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757693 * s_,
  };
}

export function hsvToOklab(hsv: HsvColor): OklabColor {
  const [r, g, b] = hsvToRgb(hsv);
  return rgbToOklab(r, g, b);
}

export function hsvToHex(hsv: HsvColor): string {
  return `#${hsvToRgb(hsv)
    .map((channel) =>
      Math.round(clamp(channel, 0, 1) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** The widest OKLab distance across the gamut, which anchors 0%. */
const widestDistance = 0.42;
/** Bends the curve so near misses still read as near misses rather than as wins. */
const errorCurve = 1.45;

/**
 * How closely a guess matches, from 0 to 100.
 *
 * 100 is exact. Above about 99.5 the two are indistinguishable side by side;
 * below 20 they are plainly different colours.
 */
export function accuracyPercentage(guess: HsvColor, target: HsvColor): number {
  const a = hsvToOklab(guess);
  const b = hsvToOklab(target);
  const distance = Math.hypot(a.L - b.L, a.a - b.a, a.b - b.b);
  const error = Math.pow(clamp(distance / widestDistance, 0, 1), errorCurve);
  return clamp((1 - error) * 100, 0, 100);
}

/**
 * The whole game's score: the mean of its rounds, in hundredths of a percent.
 *
 * The mean rather than a total, so the number means the same thing however many
 * rounds were played — this is an accuracy board, and an accuracy that grew with
 * the number of attempts would not be one.
 */
export function accuracyScore(accuracies: readonly number[]): number {
  if (accuracies.length === 0) return 0;
  const mean = accuracies.reduce((total, item) => total + item, 0) / accuracies.length;
  return Math.round(clamp(mean, 0, 100) * 100);
}
