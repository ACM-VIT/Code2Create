import { useState } from "react";
import {
  GoogleFedCmButton,
  signInWithGooglePopup,
  type Code2CreateAuthClient,
} from "@code2create/web-auth";
import {
  restrictGoogleAuthorizationToVitStudents,
  vitStudentEmailDomain,
} from "../lib/googleAuthorization";
import { ClassCard } from "../components/portal/ClassCard";
import { EmailOtpSignIn } from "../components/portal/EmailOtpSignIn";
import { PortalScene } from "../components/portal/PortalScene";
import { usePortalTheme } from "../lib/portalTheme";
import { PortalButton } from "../components/portal/PortalButton";
import { PortalError } from "../components/portal/PortalField";
import type { ParticipantClass, PublicState } from "../types";

export const participantClassStorageKey = "code2create.participant-class";

function popupErrorMessage(code: string | undefined) {
  if (code === "POPUP_BLOCKED") return "Allow pop-ups for this site, then try again.";
  if (code === "POPUP_CLOSED") return "Google sign-in was closed before it finished.";
  if (code === "POPUP_TIMEOUT") return "Google sign-in took too long. Try again.";
  return "Google sign-in could not start. Try again.";
}

export function EntryScreen({
  publicState,
  authClient,
}: {
  publicState: PublicState;
  authClient: Code2CreateAuthClient;
}) {
  const portalTheme = usePortalTheme();
  const [participantClass, setParticipantClass] = useState<ParticipantClass | null>(() => {
    const stored = sessionStorage.getItem(participantClassStorageKey);
    return stored === "vit_student" || stored === "external_participant" ? stored : null;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Before the event is published there is nothing to sign into — tease,
  // don't explain.
  if (!publicState.event) {
    return (
      <PortalScene tree="both" logo="none">
        <a
          href="https://acmvit.in"
          target="_blank"
          rel="noreferrer"
          className="absolute top-7 left-6 z-[6] opacity-85 transition-opacity hover:opacity-100 lg:top-9 lg:left-11"
        >
          <img
            src="/assets/acm-mark.svg"
            alt="ACM-VIT"
            className="size-8 [filter:var(--mark-filter)] lg:size-9"
          />
        </a>
        <div className="flex w-full max-w-[640px] flex-col items-center text-center">
          <img
            src="/assets/logo.svg"
            alt=""
            className="mb-3.5 w-11 drop-shadow-[0_0_20px_var(--logo-glow)] lg:mb-[18px] lg:w-[52px]"
          />
          <h1 className="mb-8 flex justify-center lg:mb-10">
            <img
              src="/assets/wordmark.svg"
              alt="Code2Create"
              className="h-9 w-auto [filter:var(--wordmark-filter)] sm:h-12 lg:h-[68px]"
            />
          </h1>
          <p className="mb-2 font-display font-light tracking-[-.01em] text-[26px] text-rose-light lg:text-[32px]">
            it’s cooking.
          </p>
          <p className="text-[13px] text-fg/50">come back in a little while</p>
        </div>
      </PortalScene>
    );
  }

  const authUnavailableMessage =
    participantClass === "vit_student"
      ? publicState.auth.googleConfigured
        ? null
        : "Google sign-in is unavailable right now. Ask an organizer for help."
      : publicState.auth.googleConfigured || publicState.auth.emailOtpConfigured
        ? null
        : "Sign-in is unavailable right now. Ask an organizer for help.";

  const choose = (value: ParticipantClass) => {
    sessionStorage.setItem(participantClassStorageKey, value);
    setParticipantClass(value);
    setError(null);
  };

  const fallbackSignIn = async () => {
    if (!participantClass || !publicState.auth.googleConfigured) return;
    setBusy(true);
    setError(null);
    try {
      const result = await signInWithGooglePopup(
        authClient,
        window.location.href,
        participantClass === "vit_student" ? restrictGoogleAuthorizationToVitStudents : undefined,
      );
      if (result.error) setError(popupErrorMessage(result.error.code));
    } catch {
      setError(popupErrorMessage(undefined));
    } finally {
      setBusy(false);
    }
  };

  const immediateGoogleButton = (
    <PortalButton
      type="button"
      disabled={busy}
      className="mx-auto w-full max-w-[320px]"
      onClick={() => void fallbackSignIn()}
    >
      {busy ? "Opening Google…" : "Continue with Google"}
    </PortalButton>
  );

  return (
    <PortalScene tree="both" logo="none">
      {/* The organising club's mark, top-left — the portal's only ACM branding. */}
      <a
        href="https://acmvit.in"
        target="_blank"
        rel="noreferrer"
        className="absolute top-7 left-6 z-[6] opacity-85 transition-opacity hover:opacity-100 lg:top-9 lg:left-11"
      >
        <img
          src="/assets/acm-mark.svg"
          alt="ACM-VIT"
          className="size-8 [filter:var(--mark-filter)] lg:size-9"
        />
      </a>
      <div className="flex w-full max-w-[640px] flex-col items-center text-center">
        <img
          src="/assets/logo.svg"
          alt="Code2Create"
          className="mb-3.5 w-11 drop-shadow-[0_0_20px_var(--logo-glow)] lg:mb-[18px] lg:w-[52px]"
        />
        {/* The landing page's lettered wordmark. */}
        <h1 className="mb-8 flex justify-center lg:mb-10">
          <img
            src="/assets/wordmark.svg"
            alt={publicState.event.name}
            className="h-9 w-auto [filter:var(--wordmark-filter)] sm:h-12 lg:h-[68px]"
          />
        </h1>

        <div
          className="mb-7 flex w-full flex-col gap-3 sm:flex-row sm:justify-center sm:gap-4"
          role="group"
          aria-label="Participant type"
        >
          <ClassCard
            title="VIT student"
            detail={`only @${vitStudentEmailDomain} Google accounts are accepted`}
            disabled={false}
            selected={participantClass === "vit_student"}
            onSelect={() => choose("vit_student")}
          />
          <ClassCard
            title="external participant"
            detail="continue with Google or a non-VIT email address"
            disabled={false}
            selected={participantClass === "external_participant"}
            onSelect={() => choose("external_participant")}
          />
        </div>
        <div className="flex w-full max-w-[320px] flex-col items-center gap-3">
          <div className="flex min-h-[60px] w-full items-center justify-center">
            {participantClass && publicState.auth.googleClientId ? (
              <GoogleFedCmButton
                authClient={authClient}
                appearance={portalTheme === "daybreak" ? "light" : "dark"}
                clientId={publicState.auth.googleClientId}
                {...(participantClass === "vit_student"
                  ? { hostedDomain: vitStudentEmailDomain }
                  : {})}
                loading={immediateGoogleButton}
                pending={
                  <PortalButton disabled className="mx-auto w-full">
                    Signing in…
                  </PortalButton>
                }
                fallback={immediateGoogleButton}
                onError={(message) => setError(message)}
              />
            ) : (
              <PortalButton type="button" disabled className="w-full">
                Continue with Google
              </PortalButton>
            )}
          </div>
          <div className="flex w-full items-center gap-3 text-[10.5px] font-semibold tracking-[.08em] text-fg/40">
            <span className="h-px flex-1 bg-petal-edge-soft" />
            or
            <span className="h-px flex-1 bg-petal-edge-soft" />
          </div>
          <div className="flex min-h-[100px] w-full flex-col items-stretch">
            <EmailOtpSignIn
              key={participantClass ?? "none"}
              authClient={authClient}
              configured={publicState.auth.emailOtpConfigured}
              disabled={participantClass !== "external_participant"}
              googleOnlyEmailDomain={vitStudentEmailDomain}
            />
          </div>
        </div>

        {authUnavailableMessage ? (
          <p className="mt-4 text-[11.5px] text-rose-light">{authUnavailableMessage}</p>
        ) : null}
        <PortalError message={error} reserve />
      </div>
    </PortalScene>
  );
}
