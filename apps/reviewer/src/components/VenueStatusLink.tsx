import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useReviewerSession } from "./ReviewerSession";
import { venueStatusLabels, visibleVenueStatus } from "@/lib/venue-status";
import { palette } from "@/theme";

export function VenueStatusLink() {
  const { surfaces, venue } = useReviewerSession();
  const router = useRouter();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  if (!surfaces.includes("reviews")) return null;
  const status = visibleVenueStatus(
    venue.state?.presence?.status,
    venue.state?.presence?.sampledAt,
    now,
  );
  const needsLocation =
    venue.state?.eligible &&
    venue.state.eventLive &&
    venue.state.policy?.enabled &&
    now >= venue.state.policy.startsAt &&
    now < venue.state.policy.endsAt &&
    !venue.localEnabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Venue: ${venueStatusLabels[status]}. Manage location or report leaving.`}
      onPress={() => router.push("/venue")}
      style={({ pressed }) => [styles.row, pressed ? { opacity: 0.65 } : null]}
    >
      <View style={styles.copy}>
        <Text style={styles.label}>Venue</Text>
        <Text
          style={[
            styles.value,
            status === "left" ? { color: palette.urgent } : null,
          ]}
        >
          {venueStatusLabels[status]}
        </Text>
      </View>
      <Text style={styles.action}>
        {status === "left"
          ? "Inform desk ›"
          : needsLocation
            ? "Enable location ›"
            : "Manage ›"}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.strong,
  },
  copy: { flex: 1, gap: 3 },
  label: { color: palette.muted, fontSize: 14 },
  value: { color: palette.text, fontSize: 17, fontWeight: "600" },
  action: { color: palette.judging, fontSize: 15 },
});
