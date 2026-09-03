import { sanitizeTelemetryUrl, scrubPostHogEvent } from "@code2create/client-observability/privacy";
import { usePathname } from "expo-router";
import { PostHogErrorBoundary, PostHogProvider, usePostHog } from "posthog-react-native";
import { useEffect, useRef, type ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { reviewerObservabilityConfiguration } from "./config";
import type { ReviewerRuntime } from "./runtime";
import { palette } from "@/theme";

export function ReviewerObservabilityProvider({
  children,
  runtime,
}: {
  children: ReactNode;
  runtime: ReviewerRuntime;
}) {
  const configuration = reviewerObservabilityConfiguration;
  useEffect(() => {
    if (!configuration && __DEV__) {
      console.error(
        new Error(
          "PostHog is not configured. Set the project token and host in your environment variables.",
        ),
      );
    }
  }, [configuration]);

  if (!configuration) {
    return children;
  }

  const commonProperties = {
    c2c_environment: configuration.deploymentEnvironment,
    c2c_release: configuration.release,
    c2c_surface: "reviewer-mobile",
  };
  return (
    <PostHogProvider
      apiKey={configuration.projectToken}
      autocapture={{
        captureScreens: false,
        captureTouches: true,
        propsToCapture: ["testID", "ph-label"],
      }}
      options={{
        host: configuration.host,
        before_send: scrubPostHogEvent,
        captureAppLifecycleEvents: true,
        capturePushNotificationOpened: false,
        capturePushNotificationSubscriptions: false,
        disableGeoip: true,
        enableSessionReplay: true,
        sessionReplayConfig: {
          maskAllTextInputs: true,
          maskAllImages: true,
          maskAllSandboxedViews: true,
          captureLog: false,
          captureNetworkTelemetry: true,
        },
        errorTracking: {
          autocapture: {
            console: [],
            nativeCrashes: true,
            uncaughtExceptions: true,
            unhandledRejections: true,
          },
          exceptionSteps: { enabled: false },
        },
        personProfiles: "identified_only",
        setDefaultPersonProperties: true,
      }}
    >
      <PostHogErrorBoundary
        additionalProperties={commonProperties}
        fallback={ReviewerErrorFallback}
      >
        <ReviewerTelemetry commonProperties={commonProperties} runtime={runtime} />
        {children}
      </PostHogErrorBoundary>
    </PostHogProvider>
  );
}

function ReviewerTelemetry({
  commonProperties,
  runtime,
}: {
  commonProperties: {
    c2c_environment: string;
    c2c_release: string;
    c2c_surface: string;
  };
  runtime: ReviewerRuntime;
}) {
  const pathname = usePathname();
  const posthog = usePostHog();
  const { data: session } = runtime.authClient.useSession();
  const { c2c_environment, c2c_release, c2c_surface } = commonProperties;
  const previousDistinctId = useRef<string | null>(null);
  const distinctId = session?.user.id ?? null;

  useEffect(() => {
    posthog.register({ c2c_environment, c2c_release, c2c_surface });
  }, [c2c_environment, c2c_release, c2c_surface, posthog]);

  useEffect(() => {
    if (distinctId) {
      posthog.identify(distinctId);
      previousDistinctId.current = distinctId;
      return;
    }
    if (previousDistinctId.current) {
      posthog.reset();
      previousDistinctId.current = null;
    }
  }, [distinctId, posthog]);

  useEffect(() => {
    posthog.screen(sanitizeTelemetryUrl(pathname), {
      c2c_environment,
      c2c_release,
      c2c_surface,
    });
  }, [c2c_environment, c2c_release, c2c_surface, pathname, posthog]);

  return null;
}

function ReviewerErrorFallback() {
  return (
    <View style={styles.error}>
      <Text style={styles.errorTitle}>This screen stopped unexpectedly.</Text>
      <Text style={styles.errorMessage}>
        Reopen the app. If it happens again, tell event support which screen you were using.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  error: {
    flex: 1,
    justifyContent: "center",
    padding: 24,
    backgroundColor: palette.background,
    gap: 8,
  },
  errorTitle: {
    color: palette.text,
    fontSize: 24,
    fontWeight: "600",
  },
  errorMessage: {
    color: palette.muted,
    fontSize: 16,
    lineHeight: 22,
  },
});
