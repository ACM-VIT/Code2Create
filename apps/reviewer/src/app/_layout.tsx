import { Stack } from "expo-router";
import "@/lib/venue-location";
import { StatusBar } from "expo-status-bar";
import { StrictMode } from "react";
import { StyleSheet, Text } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { ReviewerAuthProvider } from "@/components/ReviewerAuthProvider";
import { ReviewerSessionProvider } from "@/components/ReviewerSession";
import { ReviewNotificationRoute } from "@/components/ReviewNotificationRoute";
import { ReviewerObservabilityProvider } from "@/lib/observability";
import { reviewerRuntime } from "@/lib/runtime";
import { palette } from "@/theme";

function RootLayout() {
  if (!reviewerRuntime) return <ConfigurationNeeded />;

  return (
    <ReviewerObservabilityProvider runtime={reviewerRuntime}>
      <StrictMode>
        <SafeAreaProvider>
          <StatusBar style="light" />
          <ReviewerAuthProvider runtime={reviewerRuntime}>
            <ReviewerSessionProvider runtime={reviewerRuntime}>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: palette.background },
                }}
              >
                {/* Pushed routes use this title for back-button accessibility and history. */}
                <Stack.Screen name="(tabs)" options={{ title: "Duties" }} />
                <Stack.Screen name="duty/[surface]" />
                <Stack.Screen
                  name="duty/door-tools"
                  options={{
                    presentation: "formSheet",
                    headerShown: false,
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.5, 0.92],
                    sheetCornerRadius: 20,
                  }}
                />
                <Stack.Screen
                  name="duty/reviewer-phone"
                  options={{
                    presentation: "formSheet",
                    headerShown: false,
                    sheetGrabberVisible: true,
                    sheetAllowedDetents: [0.5],
                    sheetCornerRadius: 20,
                  }}
                />
              </Stack>
            <ReviewNotificationRoute />
            </ReviewerSessionProvider>
          </ReviewerAuthProvider>
        </SafeAreaProvider>
      </StrictMode>
    </ReviewerObservabilityProvider>
  );
}

function ConfigurationNeeded() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <SafeAreaView style={styles.configuration}>
        <Text style={styles.configurationTitle}>Reviewer app unavailable</Text>
        <Text style={styles.configurationMessage}>
          Ask an organizer to check the event app setup.
        </Text>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  configuration: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: palette.background,
    gap: 8,
  },
  configurationTitle: {
    color: palette.text,
    fontSize: 24,
    fontWeight: "600",
  },
  configurationMessage: {
    color: palette.muted,
    fontSize: 16,
    lineHeight: 22,
  },
});

export default RootLayout;
