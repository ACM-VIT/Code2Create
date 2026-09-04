import { PostHogErrorBoundary, PostHogProvider, usePostHog } from "@posthog/react";
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ErrorInfo, ReactNode } from "react";

import {
  parseDeploymentEnvironment,
  requiredTelemetryRelease,
  validatePostHogHost,
} from "./environment.ts";
import {
  maskReplayAttribute,
  maskReplayInput,
  maskReplayText,
  sanitizeTelemetryUrl,
  scrubPostHogEvent,
} from "./privacy.ts";
import { isChunkLoadFailure, suppressRecoveredChunkException } from "./browserRecovery.ts";

export { installBrowserChunkRecovery, isChunkLoadFailure } from "./browserRecovery.ts";

export type BrowserSurface = "landing-web" | "participant-web" | "operations-web";

export type ProductEventProperties = Record<
  `c2c_${string}`,
  string | number | boolean | null | undefined
>;

export type BrowserObservabilityConfiguration = {
  projectToken: string | undefined;
  host: string | undefined;
  deploymentEnvironment: string | undefined;
  release: string | undefined;
  surface: BrowserSurface;
  development: boolean;
};

const ObservabilityContext = createContext(false);
const missingConfigurationMessage =
  "PostHog is not configured. Set the project token and host in your environment variables.";

class LocalErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown; failed: boolean }
> {
  override state = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(error, errorInfo.componentStack);
  }

  override render() {
    return this.state.failed ? <ErrorFallback error={this.state.error} /> : this.props.children;
  }
}

export function ClientObservabilityProvider({
  children,
  configuration,
}: {
  children: ReactNode;
  configuration: BrowserObservabilityConfiguration;
}) {
  const projectToken = configuration.projectToken?.trim();
  const host = configuration.host?.trim();
  const configured =
    projectToken !== undefined &&
    projectToken.length > 0 &&
    host !== undefined &&
    host.length > 0;
  useEffect(() => {
    if (!configured && configuration.development) {
      console.error(new Error(`${configuration.surface}: ${missingConfigurationMessage}`));
    }
  }, [configuration.development, configuration.surface, configured]);

  if (!configured) {
    return <LocalErrorBoundary>{children}</LocalErrorBoundary>;
  }

  const deploymentEnvironment = parseDeploymentEnvironment(configuration.deploymentEnvironment);
  const release = requiredTelemetryRelease(configuration.release, "VITE_RELEASE_ID");
  const apiHost = validatePostHogHost(host);
  const commonProperties = {
    c2c_environment: deploymentEnvironment,
    c2c_release: release,
    c2c_surface: configuration.surface,
  };
  return (
    <ObservabilityContext.Provider value>
      <PostHogProvider
        apiKey={projectToken}
        options={{
          api_host: apiHost,
          defaults: "2026-05-30",
          advanced_disable_feature_flags: false,
          advanced_disable_feature_flags_on_first_load: false,
          autocapture: {
            dom_event_allowlist: ["click", "change", "submit"],
            element_allowlist: ["a", "button", "form", "input", "select", "textarea", "label"],
            css_selector_ignorelist: [
              ".ph-no-capture",
              "[data-ph-no-capture]",
              "[data-posthog-block]",
            ],
            capture_copied_text: false,
          },
          capture_pageview: "history_change",
          capture_pageleave: true,
          capture_dead_clicks: true,
          capture_exceptions: {
            capture_unhandled_errors: true,
            capture_unhandled_rejections: true,
            capture_console_errors: true,
          },
          capture_heatmaps: true,
          capture_performance: {
            network_timing: true,
            web_vitals: true,
          },
          disable_capture_url_hashes: true,
          disable_surveys: false,
          disable_surveys_automatic_display: false,
          disable_session_recording: false,
          enable_recording_console_log: false,
          mask_all_element_attributes: false,
          mask_all_text: false,
          person_profiles: "identified_only",
          session_recording: {
            blockSelector: ".ph-no-capture, [data-ph-no-capture], [data-posthog-block]",
            maskAllElementAttributes: false,
            maskAllInputs: false,
            maskAttributeFn: maskReplayAttribute,
            maskInputFn: maskReplayInput,
            maskTextFn: maskReplayText,
            maskTextSelector: "[data-ph-sensitive], .ph-sensitive",
            recordBody: false,
            recordHeaders: false,
            recordCrossOriginIframes: false,
            captureJsonLd: false,
            collectFonts: false,
            maskCapturedNetworkRequestFn: (request) => {
              const {
                requestBody: _requestBody,
                requestHeaders: _requestHeaders,
                responseBody: _responseBody,
                responseHeaders: _responseHeaders,
                ...safeRequest
              } = request;
              return { ...safeRequest, name: sanitizeTelemetryUrl(request.name) };
            },
          },
          error_tracking: {
            captureExtensionExceptions: false,
            exception_steps: { enabled: true },
          },
          before_send: (event) =>
            event !== null && suppressRecoveredChunkException(event)
              ? null
              : scrubPostHogEvent(event),
          loaded: (posthog) => posthog.register(commonProperties),
        }}
      >
        <PostHogErrorBoundary additionalProperties={commonProperties} fallback={ErrorFallback}>
          {children}
        </PostHogErrorBoundary>
      </PostHogProvider>
    </ObservabilityContext.Provider>
  );
}

export function useProductAnalytics() {
  const enabled = useContext(ObservabilityContext);
  const posthog = usePostHog();
  const capture = useCallback(
    (event: string, properties?: ProductEventProperties) => {
      if (!enabled) {
        return;
      }
      posthog.capture(event, properties);
    },
    [enabled, posthog],
  );

  const captureLog = useCallback(
    (level: "info" | "warn" | "error", code: string, properties?: ProductEventProperties) => {
      if (!enabled) {
        return;
      }
      posthog.capture("c2c_client_log", {
        c2c_log_level: level,
        c2c_log_code: code,
        ...properties,
      });
    },
    [enabled, posthog],
  );

  const captureException = useCallback(
    (error: unknown) => {
      if (!enabled) {
        return;
      }
      posthog.captureException(error);
    },
    [enabled, posthog],
  );

  return { capture, captureLog, captureException };
}

export function ClientObservabilityIdentity({ distinctId }: { distinctId: string | null }) {
  const enabled = useContext(ObservabilityContext);
  return enabled ? <EnabledIdentity distinctId={distinctId} /> : null;
}

function EnabledIdentity({ distinctId }: { distinctId: string | null }) {
  const posthog = usePostHog();
  const previousDistinctId = useRef<string | null>(null);
  useEffect(() => {
    if (distinctId !== null && distinctId.length > 0) {
      posthog.identify(distinctId);
      previousDistinctId.current = distinctId;
      return;
    }
    if (previousDistinctId.current !== null) {
      posthog.reset();
      previousDistinctId.current = null;
    }
  }, [distinctId, posthog]);
  return null;
}

function ErrorFallback({ error }: { error: unknown }) {
  const online = useOnlineStatus();
  const chunkFailure = isChunkLoadFailure(error);

  useEffect(() => {
    if (!chunkFailure || online) {
      return undefined;
    }
    const reload = () => window.location.reload();
    window.addEventListener("online", reload, { once: true });
    return () => window.removeEventListener("online", reload);
  }, [chunkFailure, online]);

  const title = chunkFailure
    ? online
      ? "This screen didn’t finish loading."
      : "The connection dropped while this screen was loading."
    : "This screen hit an unexpected problem.";
  const explanation = chunkFailure
    ? online
      ? "The connection is back. Try loading the screen again."
      : "Keep this page open. It will try again automatically when this device reconnects."
    : "Reload once. If it happens again, tell event support what you were trying to open.";

  return (
    <main
      style={{ background: "#0a0a09", color: "#f0eee8", minHeight: "100vh", padding: "15vh 24px" }}
    >
      <section style={{ margin: "0 auto", maxWidth: 520 }} role="alert">
        <p style={{ color: "#9b9992", margin: "0 0 12px" }}>Code2Create</p>
        <h1 style={{ fontSize: 28, fontWeight: 500, margin: "0 0 12px" }}>{title}</h1>
        <p style={{ color: "#b9b7b0", lineHeight: 1.6 }}>{explanation}</p>
        <button
          type="button"
          disabled={!online}
          onClick={() => window.location.reload()}
          style={{ cursor: online ? "pointer" : "wait", marginTop: 16 }}
        >
          {online ? "Try again" : "Waiting for connection…"}
        </button>
      </section>
    </main>
  );
}

function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    return () => {
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
    };
  }, []);

  return online;
}
