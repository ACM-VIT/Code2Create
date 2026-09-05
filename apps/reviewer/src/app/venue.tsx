import { api } from "@code2create/backend/api";
import { useMutation } from "convex/react";
import { randomUUID } from "expo-crypto";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { DutyScreen } from "@/components/DutyScreen";
import { useReviewerSession } from "@/components/ReviewerSession";
import { VenueCallSetting } from "@/components/VenueCallSetting";
import {
  Action,
  Body,
  Meta,
  Problem,
  QuietAction,
  Section,
} from "@/components/ui";
import { describeError } from "@/lib/errors";
import {
  disableVenueTracking,
  enableBackgroundVenueTracking,
  enableVenueTracking,
  refreshVenueLocation,
} from "@/lib/venue-location";
import { venueStatusLabels, visibleVenueStatus } from "@/lib/venue-status";
import { palette } from "@/theme";

export default function VenueScreen() {
  const { eventSlug, surfaces, venue } = useReviewerSession();
  const router = useRouter();
  const declareDeparture = useMutation(api.reviewerVenue.declareDeparture);
  const acknowledge = useMutation(api.reviewerVenueWarning.acknowledgeWarning);
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [leaving, setLeaving] = useState(false);
  const leaveAttempt = useRef<{ id: string; reason: string } | null>(null);
  const state = venue.state;
  const policy = state?.policy;
  const presence = state?.presence;
  const departureId = state?.departure?._id;
  const notifiedAt = state?.departure?.notifiedAt;
  const status = visibleVenueStatus(presence?.status, presence?.sampledAt, now);
  const active =
    state?.eventLive &&
    policy?.enabled &&
    now >= policy.startsAt &&
    now < policy.endsAt;
  const localTracking =
    presence?.monitoringEnabled &&
    state?.trackingOnThisDevice &&
    venue.localEnabled;

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (status !== "left" || !departureId || notifiedAt !== undefined) return;
    const send = () => {
      if (AppState.currentState === "active")
        void acknowledge({ eventSlug, departureId }).catch(() => {});
    };
    send();
    const subscription = AppState.addEventListener("change", send);
    return () => subscription.remove();
  }, [acknowledge, departureId, eventSlug, notifiedAt, status]);

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(
        describeError(
          caught,
          "That could not be saved. Check your connection and try again.",
        ),
      );
    } finally {
      setBusy(false);
      venue.refresh();
      setNow(Date.now());
    }
  };

  if (!surfaces.includes("reviews"))
    return (
      <DutyScreen title="Venue">
        <Body>Venue checks are available to reviewers.</Body>
      </DutyScreen>
    );
  if (!venue.installationId || state?.eligible === false)
    return (
      <DutyScreen title="Venue">
        <Body>
          Finish your reviewer profile and phone registration in Judging first.
        </Body>
        <Action
          label="Open Judging"
          onPress={() => router.push("/duty/reviews")}
        />
      </DutyScreen>
    );
  if (!state)
    return (
      <DutyScreen title="Venue">
        <Meta>Loading venue status…</Meta>
      </DutyScreen>
    );

  return (
    <DutyScreen title="Venue">
      <View style={styles.heading}>
        <Text style={styles.name}>{policy?.name ?? "Event venue"}</Text>
        <Text
          accessibilityLiveRegion="polite"
          style={[
            styles.status,
            status === "left" ? { color: palette.urgent } : null,
          ]}
        >
          {venueStatusLabels[status]}
        </Text>
        {presence?.sampledAt ? (
          <Meta>
            Last checked{" "}
            {new Date(presence.sampledAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </Meta>
        ) : null}
      </View>
      {error ? <Problem>{error}</Problem> : null}
      {venue.issue && localTracking ? <Problem>{venue.issue}</Problem> : null}
      {!active ? (
        <Body>
          Organizers need to enable venue checks for the live event window.
        </Body>
      ) : null}
      {!state.deviceReady ? (
        <Section title="Set up your reviewer phone">
          <Body>
            Register this phone in Judging to enable location checks and
            departure notices.
          </Body>
          <Action
            label="Open Judging"
            onPress={() => router.push("/duty/reviews")}
          />
        </Section>
      ) : null}
      {active && state.deviceReady && policy ? (
        <>
          {status === "left" ? (
            <Section title="Please inform the review desk">
              <Body>
                You have been outside longer than {policy.absenceGraceMinutes}{" "}
                minutes. Report leaving below, or refresh your location if you
                are back. We may call {policy.callDelayMinutes} minutes after
                the reminder if this stays unresolved.
              </Body>
            </Section>
          ) : null}
          {status === "reported_left" ? (
            <Section title="The desk has been informed">
              <Body>
                {state.departure?.reason ?? "Your departure is recorded."}
              </Body>
              <Meta>
                You’re off duty. When you’re back, clock in from Reviews.
              </Meta>
              <Action
                label="Go to Reviews"
                onPress={() => router.push("/duty/reviews")}
              />
            </Section>
          ) : (
            <Section title="Leaving the venue?">
              <Body>
                {state?.reviewInProgress
                  ? "Finish this review and its scorecards before leaving."
                  : "You’ll be taken off duty so your place can be covered. Your reason is visible to the desk."}
              </Body>
              {leaving ? (
                <>
                  <Text style={styles.inputLabel}>Reason for leaving</Text>
                  <TextInput
                    accessibilityLabel="Reason for leaving"
                    style={styles.input}
                    value={reason}
                    onChangeText={setReason}
                    maxLength={300}
                    multiline
                    editable={!busy}
                    placeholder="For example, taking a meal break"
                    placeholderTextColor={palette.muted}
                  />
                  <Action
                    label={busy ? "Saving…" : "Inform desk I'm leaving"}
                    disabled={
                      busy ||
                      state?.reviewInProgress ||
                      reason.trim().length < 3
                    }
                    onPress={() =>
                      run(async () => {
                        if (!venue.installationId) return;
                        if (leaveAttempt.current?.reason !== reason)
                          leaveAttempt.current = { id: randomUUID(), reason };
                        await declareDeparture({
                          eventSlug,
                          installationId: venue.installationId,
                          reason,
                          clientOperationId: leaveAttempt.current.id,
                        });
                        leaveAttempt.current = null;
                        setLeaving(false);
                        setReason("");
                      })
                    }
                  />
                  <QuietAction
                    disabled={busy}
                    label="Cancel"
                    onPress={() => setLeaving(false)}
                  />
                </>
              ) : (
                <Action
                  label="Leave and end duty"
                  disabled={busy || state?.reviewInProgress}
                  onPress={() => setLeaving(true)}
                />
              )}
            </Section>
          )}
          <Section title="Location checks">
            <Body>
              Allow location to check whether you are at this venue. Organizers
              see your venue status and last check time. Precise coordinates and
              travel history are not saved.
            </Body>
            {localTracking ? (
              <>
                <Action
                  disabled={busy}
                  label="Refresh location"
                  onPress={() => run(refreshVenueLocation)}
                />
                {!venue.backgroundEnabled ? (
                  <>
                    <Meta>
                      {venue.backgroundGranted
                        ? "Location is allowed in the background. Start checks to monitor the venue with the app closed."
                        : "For checks with the app closed, choose ‘Allow all the time’ or ‘Always’ in the next permission screen. A location indicator stays visible during checks."}
                    </Meta>
                    <Action
                      disabled={busy}
                      label={venue.backgroundGranted ? "Start background checks" : "Allow background checks"}
                      onPress={() => run(enableBackgroundVenueTracking)}
                    />
                  </>
                ) : (
                  <Meta>
                    Background checks are enabled until the event window ends.
                  </Meta>
                )}
                <QuietAction
                  disabled={busy}
                  label="Stop location checks"
                  onPress={() => run(disableVenueTracking)}
                />
              </>
            ) : (
              <Action
                disabled={busy}
                label={venue.foregroundGranted ? "Enable venue checks" : "Allow location and check venue"}
                onPress={() =>
                  run(async () => {
                    if (!venue.installationId || !venue.ownerId) return;
                    await enableVenueTracking({
                      eventSlug,
                      installationId: venue.installationId,
                      ownerId: venue.ownerId,
                      endsAt: policy.endsAt,
                      policyVersion: policy.version,
                    });
                  })
                }
              />
            )}
            <QuietAction
              label="Open location settings"
              onPress={() => run(() => Linking.openSettings())}
            />
            <Meta>
              Without fresh location, your status becomes unavailable. You can
              still report leaving.
            </Meta>
          </Section>
          <VenueCallSetting eventSlug={eventSlug} />
        </>
      ) : null}
    </DutyScreen>
  );
}

const styles = StyleSheet.create({
  heading: { gap: 8, paddingVertical: 12 },
  name: { color: palette.muted, fontSize: 16 },
  status: { color: palette.text, fontSize: 28, fontWeight: "600" },
  inputLabel: { color: palette.muted, fontSize: 14 },
  input: {
    color: palette.text,
    backgroundColor: palette.tile,
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    minHeight: 48,
  },
});
