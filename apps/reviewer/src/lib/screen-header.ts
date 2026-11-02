import { palette } from "@/theme";

export const screenHeader = {
  headerShadowVisible: false,
  headerStyle: { backgroundColor: palette.background },
  headerTintColor: palette.text,
  headerTitleStyle: { color: palette.text, fontSize: 17, fontWeight: "600" },
  headerBackButtonDisplayMode: "minimal",
  contentStyle: { backgroundColor: palette.background },
} as const;
