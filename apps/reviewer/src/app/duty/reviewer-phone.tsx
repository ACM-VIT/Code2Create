import { useLocalSearchParams } from "expo-router";
import { StyleSheet, Text, View } from "react-native";

import { KeyValue } from "@/components/ui";
import { palette, radius } from "@/theme";

export default function ReviewerPhoneSheet() {
  const params = useLocalSearchParams<{
    build?: string;
    camera?: string;
    drafts?: string;
    notifications?: string;
    panel?: string;
  }>();

  const rows: readonly (readonly [string, string])[] = [
    ...(params.panel ? ([["Panel", params.panel]] as const) : []),
    ["App build", params.build ?? "—"],
    ["Camera", params.camera ?? "—"],
    ["Notifications", params.notifications ?? "—"],
    ["Encrypted drafts", params.drafts ?? "—"],
  ];

  return (
    <View style={styles.sheet}>
      <Text style={styles.title}>This phone</Text>
      <View style={styles.body}>
        {rows.map(([label, value]) => (
          <View key={label} style={styles.row}>
            <KeyValue label={label} value={value} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: palette.background, padding: 20, gap: 16 },
  title: { color: palette.text, fontSize: 28, fontWeight: "600", letterSpacing: -0.6 },
  // ScrollView has no measurable height inside this form sheet.
  body: { gap: 10 },
  row: {
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
});
