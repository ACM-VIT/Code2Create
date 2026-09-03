/// <reference types="google.accounts" />

import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";

import { googleButtonConfiguration, googleFedCmConfiguration } from "./google-fedcm-config";
import type { Code2CreateAuthClient } from "./index";

declare global {
  interface Navigator {
    brave?: {
      isBrave: () => Promise<boolean>;
    };
  }

  interface Window {
    IdentityCredential?: object;
  }
}

type ButtonPhase = "loading" | "ready" | "signing-in" | "unavailable";
type ButtonLayer = 0 | 1;
type ButtonAppearance = "light" | "dark";

const googleIdentityScriptUrl = "https://accounts.google.com/gsi/client";
let googleIdentityScript: Promise<void> | null = null;

/** Starts the shared GIS download before a Google button needs to render. */
export function preloadGoogleIdentityServices() {
  return loadGoogleIdentityServices();
}

export function GoogleFedCmButton({
  authClient,
  clientId,
  hostedDomain,
  appearance = "dark",
  loading,
  pending,
  fallback,
  onError,
}: {
  authClient: Code2CreateAuthClient;
  clientId: string;
  hostedDomain?: string;
  /** Matches Google's button to the surrounding page theme. */
  appearance?: ButtonAppearance;
  loading: ReactNode;
  pending: ReactNode;
  fallback: ReactNode;
  onError: (message: string) => void;
}) {
  const firstContainer = useRef<HTMLDivElement>(null);
  const secondContainer = useRef<HTMLDivElement>(null);
  const activeLayerRef = useRef<ButtonLayer | null>(null);
  const errorHandler = useRef(onError);
  const signInPending = useRef(false);
  const [activeLayer, setActiveLayer] = useState<ButtonLayer | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [phase, setPhase] = useState<ButtonPhase>("loading");

  useEffect(() => {
    errorHandler.current = onError;
  }, [onError]);

  useEffect(() => {
    const nextLayer: ButtonLayer = activeLayerRef.current === 0 ? 1 : 0;
    const element = nextLayer === 0 ? firstContainer.current : secondContainer.current;
    if (element === null) return undefined;
    const hasActiveButton = activeLayerRef.current !== null;
    let active = true;
    if (hasActiveButton) {
      setReplacing(true);
    }

    const receiveCredential = async (response: google.accounts.id.CredentialResponse) => {
      if (!active || signInPending.current) {
        return;
      }
      signInPending.current = true;
      setPhase("signing-in");
      try {
        const result = await authClient.$fetch("/one-tap/callback", {
          method: "POST",
          body: {
            idToken: response.credential,
          },
          throw: false,
        });
        if (result.error) {
          if (active) {
            setPhase("ready");
            errorHandler.current(
              "Google could not complete sign-in. Try again or use another account.",
            );
          }
          return;
        }
        await authClient.updateSession();
      } catch {
        if (active) {
          setPhase("ready");
          errorHandler.current(
            "Google could not complete sign-in. Try again or use another account.",
          );
        }
      } finally {
        signInPending.current = false;
      }
    };

    void (async () => {
      try {
        const [, useFedCm] = await Promise.all([
          loadGoogleIdentityServices(),
          supportsGoogleFedCmButton(),
        ]);
        if (!active) {
          return;
        }

        google.accounts.id.initialize(
          googleFedCmConfiguration({
            clientId,
            ...(hostedDomain !== undefined && hostedDomain.length > 0 ? { hostedDomain } : {}),
            onCredential: (response) => void receiveCredential(response),
            useFedCm,
          }),
        );
        element.replaceChildren();
        const buttonWidth =
          element.parentElement?.getBoundingClientRect().width ??
          element.getBoundingClientRect().width;
        google.accounts.id.renderButton(
          element,
          googleButtonConfiguration(buttonWidth, appearance),
        );
        const ready = await waitForRenderedGoogleButton(element, () => active);
        if (!active) {
          return;
        }
        if (!ready) {
          throw new Error("Google button did not finish rendering.");
        }

        await waitForGoogleButtonPaint(() => active);
        if (!active) {
          return;
        }

        activeLayerRef.current = nextLayer;
        setActiveLayer(nextLayer);
        setReplacing(false);
        setPhase("ready");
      } catch {
        if (!active) {
          return;
        }
        setReplacing(false);
        setPhase("unavailable");
      }
    })();

    return () => {
      active = false;
    };
  }, [appearance, authClient, clientId, hostedDomain]);

  const googleLayer = (layer: ButtonLayer, ref: RefObject<HTMLDivElement | null>) => {
    const visible = phase === "ready" && activeLayer === layer;
    return (
      <div
        ref={ref}
        aria-hidden={!visible}
        style={{
          gridArea: "1 / 1",
          display: "grid",
          height: 55,
          alignItems: "center",
          opacity: visible ? 1 : 0,
          pointerEvents: visible && !replacing ? "auto" : "none",
          width: "100%",
        }}
      />
    );
  };

  return (
    <div
      style={{
        display: "grid",
        width: "100%",
        maxWidth: 320,
        height: 55,
        marginInline: "auto",
        alignItems: "center",
        overflow: "hidden",
      }}
    >
      {/* The backing only stands in for a Google button that is actually
          there; while the portal's own button covers loading or fallback,
          two buttons must never show through each other. */}
      {phase === "ready" ? <GoogleButtonBacking appearance={appearance} /> : null}
      {googleLayer(0, firstContainer)}
      {googleLayer(1, secondContainer)}
      {phase === "loading" ? <div style={{ gridArea: "1 / 1" }}>{loading}</div> : null}
      {phase === "signing-in" ? <div style={{ gridArea: "1 / 1" }}>{pending}</div> : null}
      {phase === "unavailable" ? <div style={{ gridArea: "1 / 1" }}>{fallback}</div> : null}
    </div>
  );
}

function GoogleButtonBacking({ appearance }: { appearance: ButtonAppearance }) {
  const dark = appearance === "dark";

  return (
    <div
      aria-hidden="true"
      data-google-button-backing
      style={{
        gridArea: "1 / 1",
        alignSelf: "center",
        boxSizing: "border-box",
        display: "grid",
        gridTemplateColumns: "38px 1fr 38px",
        alignItems: "center",
        width: "100%",
        height: 40,
        overflow: "hidden",
        border: dark ? "1px solid #202124" : "1px solid #747775",
        borderRadius: 9999,
        background: dark ? "#202124" : "#ffffff",
        color: dark ? "#ffffff" : "#1f1f1f",
        fontFamily: "Roboto, Arial, sans-serif",
        fontSize: 14,
        fontWeight: 500,
        letterSpacing: "0.25px",
        lineHeight: "20px",
        pointerEvents: "none",
        userSelect: "none",
      }}
    >
      <span
        style={{
          display: "grid",
          width: 36,
          height: 36,
          marginLeft: 1,
          placeItems: "center",
          borderRadius: "50%",
          background: dark ? "#ffffff" : "transparent",
        }}
      >
        <GoogleMark />
      </span>
      <span style={{ whiteSpace: "nowrap" }}>Continue with Google</span>
      <span />
    </div>
  );
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18">
      <path
        fill="#4285f4"
        d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.716v2.259h2.909c1.702-1.567 2.684-3.875 2.684-6.616Z"
      />
      <path
        fill="#34a853"
        d="M9 18c2.43 0 4.468-.806 5.956-2.179l-2.91-2.259c-.805.54-1.835.859-3.046.859-2.344 0-4.328-1.585-5.037-3.714H.956v2.332A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#fbbc05"
        d="M3.963 10.707A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.281-1.707V4.961H.956A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.039l3.007-2.332Z"
      />
      <path
        fill="#ea4335"
        d="M9 3.579c1.321 0 2.507.454 3.442 1.346l2.581-2.582C13.464.892 11.426 0 9 0A9 9 0 0 0 .956 4.961l3.007 2.332C4.672 5.164 6.656 3.579 9 3.579Z"
      />
    </svg>
  );
}

function waitForRenderedGoogleButton(element: HTMLDivElement, isActive: () => boolean) {
  const startedAt = performance.now();
  return new Promise<boolean>((resolve) => {
    const check = () => {
      if (!isActive()) {
        resolve(false);
        return;
      }
      const iframe = [...element.querySelectorAll("iframe")].find(
        (candidate) => candidate.title === "Sign in with Google Button",
      );
      const bounds = iframe?.getBoundingClientRect();
      if (bounds && bounds.width > 0 && bounds.height > 0) {
        resolve(true);
        return;
      }
      if (performance.now() - startedAt >= 8000) {
        resolve(false);
        return;
      }
      window.requestAnimationFrame(check);
    };
    window.requestAnimationFrame(check);
  });
}

function waitForGoogleButtonPaint(isActive: () => boolean) {
  return new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!isActive()) {
          resolve();
          return;
        }
        window.setTimeout(resolve, 120);
      });
    });
  });
}

async function supportsGoogleFedCmButton() {
  if (window.IdentityCredential === undefined) return false;
  if (navigator.brave === undefined) return true;

  try {
    return !(await navigator.brave.isBrave());
  } catch {
    return false;
  }
}

function loadGoogleIdentityServices() {
  if (typeof google !== "undefined" && google.accounts?.id !== undefined) {
    return Promise.resolve();
  }
  if (googleIdentityScript !== null) return googleIdentityScript;

  googleIdentityScript = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    const timeout = window.setTimeout(
      () => reject(new Error("Google Identity Services timed out.")),
      8000,
    );
    script.src = googleIdentityScriptUrl;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => {
      window.clearTimeout(timeout);
      if (typeof google === "undefined" || google.accounts?.id === undefined) {
        reject(new Error("Google Identity Services did not initialize."));
        return;
      }
      resolve();
    });
    script.addEventListener("error", () => {
      window.clearTimeout(timeout);
      reject(new Error("Google Identity Services could not be loaded."));
    });
    document.head.append(script);
  });
  void googleIdentityScript.catch(() => {
    googleIdentityScript = null;
  });
  return googleIdentityScript;
}
