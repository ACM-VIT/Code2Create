import { palette } from "@/theme";

export const screenHeader = {
  headerShadowVisible: false,
  headerStyle: { backgroundColor: palette.background },
  headerTintColor: palette.text,
  headerTitleStyle: { color: palette.text, fontSize: 17, fontWeight: "600" },
  headerBackButtonDisplayMode: "minimal",
  contentStyle: { backgroundColor: palette.background },
} as const;

// Use only on scrolling screens; full-bleed content can intercept header taps.
export const scrollingScreenHeader = {
  ...screenHeader,
  headerTransparent: true,
  headerStyle: { backgroundColor: "transparent" },
} as const;
