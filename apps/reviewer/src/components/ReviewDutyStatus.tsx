import { useState } from "react";
import { StyleSheet, Text, TextInput } from "react-native";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { randomUUID } from "expo-crypto";
import { api } from "@code2create/backend/api";
import { Action, ChipRow, QuietAction, Sheet } from "@/components/ui";
import { useMutationAttempt } from "@/lib/mutation-attempt";
import { describeError } from "@/lib/errors";
import { palette, radius } from "@/theme";

type ReviewerNow = FunctionReturnType<typeof api.reviewer.now>;
const returnChoices = [5, 10, 15, 20, 30, 45, 60] as const;

export function ReviewDutyStatus({
  eventSlug,
  installationId,
  assignment,
  canChangeDuty,
}: {
  eventSlug: string;
  installationId: string;
  assignment: ReviewerNow["panel"] | ReviewerNow["reserve"];
  canChangeDuty: boolean;
}) {
  const setAvailability = useMutation(api.reviewer.setAvailability);
  const [open, setOpen] = useState(false);
  const [endingShift, setEndingShift] = useState(false);
  const [reason, setReason] = useState("");
  const [returnMinutes, setReturnMinutes] = useState<number>(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availabilityAttempt =
    useMutationAttempt<
      FunctionReturnType<typeof api.reviewer.setAvailability>
    >();
  const slot = `reviewer-availability:${assignment?.round.id ?? "none"}`;
  const availabilityPending = availabilityAttempt.hasPending(slot);
  const clockIn = assignment?.clockIn;

  const stepAway = async () => {
    if (!canChangeDuty || !assignment || !clockIn || busy) return;
    const minutes = returnMinutes;
    if (!endingShift && (!Number.isSafeInteger(minutes) || minutes < 1)) {
      setError("Expected return must be a positive whole number of minutes.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await availabilityAttempt.run(slot, () => {
        const args = {
          eventSlug,
          roundId: assignment.round.id,
          installationId,
          status: endingShift
            ? ("clocked_out" as const)
            : ("temporarily_unavailable" as const),
          reason,
          ...(endingShift ? {} : { expectedReturnMinutes: minutes }),
          expectedVersion: clockIn.version,
          clientOperationId: randomUUID(),
        };
        return () => setAvailability(args);
      });
      setOpen(false);
    } catch (caught) {
      setError(describeError(caught, "Availability could not be changed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {canChangeDuty ? (
        <QuietAction
          label="Change duty status"
          onPress={() => {
            if (!availabilityPending) {
              setEndingShift(false);
              setReason("");
              setReturnMinutes(10);
              setError(null);
            }
            setOpen(true);
          }}
        />
      ) : null}
      <Sheet
        onClose={() => setOpen(false)}
        title={endingShift ? "End my shift" : "Step away"}
        visible={open && canChangeDuty}
      >
        <ChipRow
          accent={palette.judging}
          selected={endingShift ? "end" : "break"}
          options={[
            ["break", "Short break"],
            ["end", "End shift"],
          ]}
          onSelect={(value) => {
            if (!busy && !availabilityPending) setEndingShift(value === "end");
          }}
        />
        <Text style={styles.label}>Reason</Text>
        <TextInput
          editable={!busy && !availabilityPending}
          onChangeText={(value) => {
            setReason(value);
            setError(null);
          }}
          placeholder="Why are you stepping away?"
          placeholderTextColor={palette.faint}
          style={styles.input}
          value={reason}
        />
        {!endingShift ? (
          <>
            <Text style={styles.label}>Expected return in minutes</Text>
            <ChipRow
              accent={palette.judging}
              onSelect={(value) => {
                if (busy || availabilityPending) return;
                setReturnMinutes(Number(value));
                setError(null);
              }}
              options={returnChoices.map(
                (minutes) => [String(minutes), String(minutes)] as const,
              )}
              selected={String(returnMinutes)}
            />
          </>
        ) : null}
        <Action
          disabled={busy || reason.trim().length < 3}
          label={
            busy
              ? "Updating…"
              : availabilityPending
                ? "Confirm earlier update"
                : endingShift
                  ? "Confirm end of shift"
                  : "Confirm step away"
          }
          onPress={stepAway}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </Sheet>
    </>
  );
}

const styles = StyleSheet.create({
  label: { color: palette.faint, fontSize: 13 },
  error: { color: palette.urgent, fontSize: 14, lineHeight: 20 },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: palette.tile,
    borderRadius: radius.tile,
    color: palette.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: "top",
    fontSize: 14,
    lineHeight: 20,
  },
});
