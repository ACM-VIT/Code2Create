import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { randomUUID } from "expo-crypto";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { Action, Problem, QuietAction, Sheet } from "@/components/ui";
import { describeError } from "@/lib/errors";
import { useMutationAttempt } from "@/lib/mutation-attempt";
import { palette } from "@/theme";

type Confirmation = FunctionReturnType<
  typeof api.reviewConfirmations.mine
>[number];
const time = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
});
const date = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
});

export function ReviewAvailability({ eventSlug }: { eventSlug: string }) {
  const rounds = useQuery(api.reviewConfirmations.mine, { eventSlug });
  return (
    <>
      {rounds?.map((round) => (
        <AvailabilityCard
          key={`${round.roundId}:${round.response.version}`}
          eventSlug={eventSlug}
          round={round}
        />
      ))}
    </>
  );
}

function AvailabilityCard({
  eventSlug,
  round,
}: {
  eventSlug: string;
  round: Confirmation;
}) {
  const respond = useMutation(api.reviewConfirmations.respond);
  const attempt =
    useMutationAttempt<
      FunctionReturnType<typeof api.reviewConfirmations.respond>
    >();
  const [editing, setEditing] = useState(false);
  const [customHours, setCustomHours] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attemptKey = `availability:${round.roundId}`;
  const pending = attempt.hasPending(attemptKey);
  const slots: { startsAt: number; endsAt: number }[] = [];
  for (
    let startsAt = round.startsAt;
    startsAt < round.endsAt;
    startsAt += 30 * 60_000
  ) {
    slots.push({
      startsAt,
      endsAt: Math.min(startsAt + 30 * 60_000, round.endsAt),
    });
  }
  const [selected, setSelected] = useState(
    () =>
      new Set(
        slots
          .filter((slot) =>
            round.response.windows.some(
              (window) =>
                window.startsAt <= slot.startsAt &&
                window.endsAt >= slot.endsAt,
            ),
          )
          .map((slot) => slot.startsAt),
      ),
  );

  const save = async (choice: "selected" | "whole" | "unavailable") => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run(attemptKey, () => {
        const args = {
          eventSlug,
          roundId: round.roundId,
          windows:
            choice === "unavailable"
              ? []
              : choice === "whole"
                ? slots
                : slots.filter((slot) => selected.has(slot.startsAt)),
          expectedVersion: round.response.version,
          clientOperationId: randomUUID(),
        };
        return () => respond(args);
      });
      setEditing(false);
    } catch (caught) {
      setError(describeError(caught, "Your availability could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{round.name} · availability</Text>
      <Text style={styles.body}>
        {date.format(round.startsAt)} · {time.format(round.startsAt)}–
        {time.format(round.endsAt)} IST
      </Text>
      {round.state === "scheduled" ? (
        <Text style={styles.body}>
          Confirm in the app from {time.format(round.opensAt)} on{" "}
          {date.format(round.opensAt)}.
        </Text>
      ) : (
        <>
          {round.response.status === "pending" ? (
            <Action
              label="Confirm availability"
              onPress={() => setEditing(true)}
            />
          ) : (
            <>
              <Text style={styles.body}>
                {round.response.status === "unavailable"
                  ? "Unavailable for this round"
                  : round.response.windows
                      .map(
                        (window) =>
                          `${time.format(window.startsAt)}–${time.format(window.endsAt)}`,
                      )
                      .join(", ")}
              </Text>
              <QuietAction
                label="Change hours"
                onPress={() => setEditing(true)}
              />
            </>
          )}
          <Sheet
            title={`${round.name} · your hours`}
            visible={editing}
            onClose={() => setEditing(false)}
          >
            <Text style={styles.body}>When can you review?</Text>
            {!customHours ? (
              <>
                <Action
                  disabled={busy}
                  label={
                    busy
                      ? "Saving…"
                      : pending
                        ? "Retry saving"
                        : "The whole round"
                  }
                  onPress={() => save("whole")}
                />
                {!pending ? (
                  <QuietAction
                    label="Choose my hours"
                    onPress={() => setCustomHours(true)}
                  />
                ) : null}
              </>
            ) : (
              <>
                <ScrollView style={{ maxHeight: 300 }}>
                  <View style={styles.slots}>
                    {slots.map((slot) => {
                      const checked = selected.has(slot.startsAt);
                      return (
                        <Pressable
                          key={slot.startsAt}
                          accessibilityRole="checkbox"
                          accessibilityState={{
                            checked,
                            disabled: busy || pending,
                          }}
                          disabled={busy || pending}
                          onPress={() =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (next.has(slot.startsAt))
                                next.delete(slot.startsAt);
                              else next.add(slot.startsAt);
                              return next;
                            })
                          }
                          style={[
                            styles.slot,
                            checked ? styles.selected : null,
                          ]}
                        >
                          <Text
                            style={[
                              styles.slotText,
                              checked ? styles.selectedText : null,
                            ]}
                          >
                            {time.format(slot.startsAt)}–
                            {time.format(slot.endsAt)}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </ScrollView>
                <Action
                  disabled={busy || (!pending && selected.size === 0)}
                  label={
                    busy
                      ? "Saving…"
                      : pending
                        ? "Retry saving"
                        : "Confirm my hours"
                  }
                  onPress={() => save("selected")}
                />
              </>
            )}
            {!pending ? (
              <QuietAction
                label="I’m unavailable"
                onPress={() => save("unavailable")}
              />
            ) : null}
            {error ? <Problem>{error}</Problem> : null}
          </Sheet>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: 14,
    paddingVertical: 22,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: palette.faint,
  },
  heading: { color: palette.text, fontSize: 20, fontWeight: "600" },
  body: { color: palette.muted, fontSize: 15, lineHeight: 22 },
  slots: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  slot: {
    paddingVertical: 13,
    paddingHorizontal: 14,
    borderRadius: 8,
    backgroundColor: palette.tile,
  },
  slotText: { color: palette.text, fontSize: 14 },
  selected: { backgroundColor: palette.judging },
  selectedText: { color: palette.onJudging },
});
