import { loadFont as loadShippori } from "@remotion/google-fonts/ShipporiMincho";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadInterTight } from "@remotion/google-fonts/InterTight";

export const serif = loadShippori("normal", {
  weights: ["400", "500"],
  subsets: ["latin"],
}).fontFamily;

export const sans = loadInter("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
}).fontFamily;

export const launch = loadInterTight("normal", {
  weights: ["500", "600", "700"],
  subsets: ["latin"],
}).fontFamily;
