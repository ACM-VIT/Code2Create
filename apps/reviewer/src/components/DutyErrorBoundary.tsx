import { type ErrorBoundaryProps, useRouter } from "expo-router";
import { usePostHog } from "posthog-react-native";
import { useEffect } from "react";
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Action, Body, Heading, QuietAction } from "./ui";
import { palette } from "@/theme";

/** Keep a failed duty from taking down the session and every other duty. */
export function DutyErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const router = useRouter();
  const posthog = usePostHog();
  useEffect(() => {
    posthog?.captureException(error, { c2c_surface: "reviewer-mobile", c2c_context: "duty" });
  }, [error, posthog]);

  return (
    <SafeAreaView style={styles.screen}>
      <Heading>This screen couldn’t load.</Heading>
      <Body>Try again or return to your duties.</Body>
      <Action label="Try again" onPress={retry} />
      <QuietAction label="Back to duties" onPress={() => router.replace("/")} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: "center", padding: 24, gap: 16, backgroundColor: palette.background },
});
