import { venueCallConsentVersion } from "@code2create/domain";
import { api } from "@code2create/backend/api";
import { useMutation, useQuery } from "convex/react";
import { randomUUID } from "expo-crypto";
import { useRef, useState } from "react";
import { StyleSheet, Text, TextInput } from "react-native";
import { Action, Meta, Problem, QuietAction, Section } from "./ui";
import { describeError } from "@/lib/errors";
import { palette } from "@/theme";

export function VenueCallSetting({ eventSlug }: { eventSlug: string }) {
  const purpose = "reviewer_venue_absence" as const;
  const consent = useQuery(api.outboundCallConsents.mine, {
    eventSlug,
    purpose,
  });
  const save = useMutation(api.outboundCallConsents.saveReviewerConsent);
  const [phone, setPhone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{
    state: "granted" | "revoked";
    phone: string;
    version: number;
    id: string;
  } | null>(null);
  if (!consent) return null;
  const value =
    phone ?? consent.destinationPhoneE164 ?? consent.suggestedPhoneE164 ?? "";
  const change = async (state: "granted" | "revoked") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (
        !pending.current ||
        pending.current.state !== state ||
        pending.current.phone !== value ||
        pending.current.version !== consent.version
      )
        pending.current = {
          state,
          phone: value,
          version: consent.version,
          id: randomUUID(),
        };
      await save({
        eventSlug,
        purpose,
        state,
        consentPolicyVersion: venueCallConsentVersion,
        destinationPhone: value,
        expectedVersion: consent.version,
        clientOperationId: pending.current.id,
      });
      pending.current = null;
    } catch (caught) {
      setError(describeError(caught, "Call settings could not be saved."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Check-in calls">
      <Meta>
        Automated calls confirm availability. Ops can read the transcript.
      </Meta>
      <Text style={styles.label}>Phone number</Text>
      <TextInput
        accessibilityLabel="Departure call phone number"
        style={styles.input}
        keyboardType="phone-pad"
        value={value}
        onChangeText={setPhone}
        placeholder="+919876543210"
        placeholderTextColor={palette.muted}
        editable={!busy}
      />
      {error ? <Problem>{error}</Problem> : null}
      <Action
        label={
          busy
            ? "Saving…"
            : consent.state === "granted"
              ? "Update call number"
              : "Allow check-in calls"
        }
        disabled={busy || !value.trim()}
        onPress={() => change("granted")}
      />
      {consent.state === "granted" ? (
        <QuietAction
          label="Turn off check-in calls"
          disabled={busy}
          onPress={() => change("revoked")}
        />
      ) : null}
    </Section>
  );
}

const styles = StyleSheet.create({
  label: { color: palette.muted, fontSize: 14 },
  input: {
    color: palette.text,
    backgroundColor: palette.tile,
    borderRadius: 10,
    padding: 14,
    fontSize: 16,
    minHeight: 48,
  },
});
