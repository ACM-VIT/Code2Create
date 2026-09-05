import { api } from "@code2create/backend/api";
import { useConvexAuth, useQuery } from "convex/react";
import { createContext, useContext, useState, type ReactNode } from "react";

import { PagerAlert } from "@/components/PagerAlert";
import { VenueNotificationRouting } from "@/components/VenueNotificationRouting";
import {
  PrimaryAction,
  ReviewerBooting,
  ReviewerGate,
} from "@/components/ReviewerSessionGate";
import type { DutyStatus } from "@/lib/duty-status";
import { describeError } from "@/lib/errors";
import { reviewerSurfaces, type Surface } from "@/lib/reviewer-surfaces";
import type { ReviewerRuntime } from "@/lib/runtime";
import { useReviewerDuty } from "@/lib/use-reviewer-duty";
import { useReviewerVenue } from "@/lib/use-reviewer-venue";
import { disableVenueTracking } from "@/lib/venue-location";

type ReviewerSession = {
  runtime: ReviewerRuntime;
  eventSlug: string;
  who: string;
  email: string;
  surfaces: Surface[];
  canCreateSupport: boolean;
  canManageAttention: boolean;
  judgingStatus: DutyStatus;
  reviewHeartbeatIssue: string | null;
  venue: ReturnType<typeof useReviewerVenue>;
  signOut: () => void;
};

const SessionContext = createContext<ReviewerSession | null>(null);
export function useReviewerSession() {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useReviewerSession used outside the reviewer session provider.",
    );
  return session;
}

export function ReviewerSessionProvider({
  children,
  runtime,
}: {
  children: ReactNode;
  runtime: ReviewerRuntime;
}) {
  const eventSlug = runtime.configuration.eventSlug;
  const { data: session, isPending: sessionPending } = runtime.authClient.useSession();
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const publicState = useQuery(api.system.getPublicShellState, { eventSlug });
  const access = useQuery(
    api.access.reviewerCapabilities,
    isAuthenticated ? { eventSlug } : "skip",
  );
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);
  const reviewerDuty = useReviewerDuty(eventSlug, access?.reviews ?? false);
  const venue = useReviewerVenue(
    eventSlug,
    isAuthenticated && (access?.reviews ?? false),
    reviewerDuty.installationId ?? null,
    session?.user.id ?? null,
  );

  if (sessionPending || authLoading || publicState === undefined) return <ReviewerBooting />;
  if (isAuthenticated && access === undefined) return <ReviewerBooting />;

  if (!session?.session || !isAuthenticated) {
    const signIn = async () => {
      setAuthBusy(true);
      setAuthError(null);
      try {
        const result = await runtime.authClient.signIn.social({
          provider: "google",
          callbackURL: "/",
        });
        if (result.error) {
          setAuthError("Google sign-in could not be completed. Try again.");
        }
      } catch (caught) {
        setAuthError(describeError(caught, "Google sign-in could not be completed."),
        );
      } finally {
        setAuthBusy(false);
      }
    };
    return (
      <ReviewerGate
        error={
          authError ??
          (publicState.auth.googleConfigured
            ? null
            : "Google sign-in is unavailable. Ask an organizer to check event access.")
        }
        title="Sign in to work this event"
      >
        <PrimaryAction
          disabled={authBusy || !publicState.auth.googleConfigured}
          label={authBusy ? "Opening…" : "Continue with Google"}
          onPress={signIn}
        />
      </ReviewerGate>
    );
  }

  const signOut = () => {
    void (async () => {
      try {
        await disableVenueTracking();
      } finally {
        await runtime.authClient.signOut();
      }
    })().catch(() => {
      setAuthError("Sign out could not finish. Try again.");
    });
  };

  if (!access) {
    return (
      <ReviewerGate error={null} title="No access yet" who={session.user.email}>
        <PrimaryAction label="Sign out" onPress={signOut} secondary />
      </ReviewerGate>
    );
  }

  const surfaces = reviewerSurfaces(access);

  if (surfaces.length === 0) {
    return (
      <ReviewerGate error={null} title="Nothing assigned yet" who={session.user.email}>
        <PrimaryAction label="Sign out" onPress={signOut} secondary />
      </ReviewerGate>
    );
  }

  return (
    <SessionContext.Provider
      value={{
        runtime,
        eventSlug,
        who: session.user.name || session.user.email,
        email: session.user.email,
        surfaces,
        canCreateSupport: access.supportCreate,
        canManageAttention: access.attentionManage,
        judgingStatus: reviewerDuty.judgingStatus,
        reviewHeartbeatIssue: reviewerDuty.heartbeatIssue,
        venue,
        signOut,
      }}
    >
      {children}
      {access.reviews ? <VenueNotificationRouting /> : null}
      {reviewerDuty.page ? (
        <PagerAlert
          eventSlug={eventSlug}
          installationId={reviewerDuty.installationId}
          page={reviewerDuty.page}
        />
      ) : null}
    </SessionContext.Provider>
  );
}
