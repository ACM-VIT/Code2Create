import { api } from "@code2create/backend/api";
import { useMutation, useQuery } from "convex/react";
import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useState } from "react";
import { AppState, StyleSheet, Text, TextInput, View } from "react-native";

import { Action, CheckRow, QuietAction } from "@/components/ui";
import { describeError } from "@/lib/errors";
import { openPagingSetting } from "@/lib/paging-settings";
import { pagingReadiness, type PagingReadinessCheck } from "@/lib/push-notifications";
import { palette, radius } from "@/theme";

export function PagingSetup({
  eventSlug,
  onDone,
  requestPermission,
  tokenMissing = false,
  tokenRejected = false,
}: {
  eventSlug: string;
  onDone?: () => void;
  requestPermission: () => Promise<void>;
  tokenRejected?: boolean;
  tokenMissing?: boolean;
}) {
  const [checks, setChecks] = useState<PagingReadinessCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [callBusy, setCallBusy] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [phoneOverride, setPhoneOverride] = useState<string | null>(null);
  const callConsent = useQuery(api.outboundCallConsents.mine, { eventSlug });
  const saveCallConsent = useMutation(api.outboundCallConsents.saveReviewerConsent);

  const refresh = useCallback(() => {
    void pagingReadiness().then(setChecks);
  }, []);

  useEffect(refresh, [refresh]);

  // Refresh after returning from Settings; an immediate read is stale.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const permission = checks?.find((check) => check.key === "permission");
  const settled = permission?.met === true;
  const callsEnabled = callConsent?.state === "granted";
  const phone =
    phoneOverride ?? callConsent?.destinationPhoneE164 ?? callConsent?.suggestedPhoneE164 ?? "+91";

  const changeCallConsent = async (state: "granted" | "revoked") => {
    if (!callConsent || callBusy) return;
    setCallBusy(true);
    setCallError(null);
    try {
      await saveCallConsent({
        eventSlug,
        state,
        ...(state === "granted" ? { destinationPhone: phone } : {}),
        expectedVersion: callConsent.version,
        clientOperationId: randomUUID(),
      });
      setPhoneOverride(null);
    } catch (caught: unknown) {
      setCallError(describeError(caught, "The phone fallback could not be changed."));
    } finally {
      setCallBusy(false);
    }
  };

  return (
    <View style={styles.body}>
      <View accessibilityElementsHidden style={styles.preview}>
        <View style={styles.previewText}>
          <Text style={styles.previewTitle}>Substitute request</Text>
          <Text numberOfLines={2} style={styles.previewBody}>
            Panel A · Table 12 needs a reviewer.
          </Text>
        </View>
        <Text style={styles.previewWhen}>now</Text>
      </View>

      <Text style={styles.lead}>A panel short a reviewer waits on this phone.</Text>

      <View style={styles.rows}>
        {tokenRejected || tokenMissing ? (
          <CheckRow
            consequence={
              tokenRejected
                ? "This phone was refused by the push service — allow notifications again, or reinstall"
                : "This phone has no address to be paged at yet — reopen this after a moment online"
            }
            met={false}
            onPress={() => void openPagingSetting("notification_settings")}
            title="Reachable"
          />
        ) : null}
        {(checks ?? []).map((check, index) => {
          const fix = check.fix;
          return (
            <View key={check.key} style={index === 0 ? undefined : styles.divider}>
              <CheckRow
                consequence={check.consequence}
                met={check.met}
                title={check.title}
                {...(fix
                  ? {
                      onPress: async () => {
                        await openPagingSetting(fix);
                      },
                    }
                  : {})}
              />
            </View>
          );
        })}
      </View>

      <View style={styles.callSection}>
        <CheckRow
          consequence={
            callConsent === undefined
              ? "Checking your call setting"
              : callsEnabled
                ? `Calls go to ${callConsent.destinationPhoneE164}`
                : callConsent.state === "needs_confirmation"
                  ? "Review the current call notice to keep phone fallback on"
                  : "Optional fallback after push; it does not accept a page for you"
          }
          met={callsEnabled}
          title="Phone fallback"
        />
        <Text style={styles.callNotice}>
          If push does not reach you, Code2Create may call this number with a short synthesized
          page. The call only asks you to open the app.
        </Text>
        <TextInput
          autoComplete="tel"
          editable={!callBusy}
          keyboardType="phone-pad"
          maxLength={20}
          onChangeText={setPhoneOverride}
          placeholder="+91 98765 43210"
          placeholderTextColor={palette.faint}
          style={styles.phoneInput}
          textContentType="telephoneNumber"
          value={phone}
        />
        {callError ? <Text style={styles.callError}>{callError}</Text> : null}
        {callsEnabled ? (
          <View style={styles.callActions}>
            <Action
              accent={palette.judging}
              disabled={callBusy}
              label={callBusy ? "Saving…" : "Update number"}
              onPress={() => void changeCallConsent("granted")}
            />
            <QuietAction
              label="Turn off phone calls"
              onPress={() => void changeCallConsent("revoked")}
            />
          </View>
        ) : (
          <Action
            accent={palette.judging}
            disabled={callBusy || callConsent === undefined}
            label={callBusy ? "Saving…" : "Allow phone fallback"}
            onPress={() => void changeCallConsent("granted")}
          />
        )}
      </View>

      {!settled ? (
        <Action
          accent={palette.judging}
          disabled={busy}
          label={busy ? "Asking…" : "Allow notifications"}
          onPress={async () => {
            setBusy(true);
            try {
              await requestPermission();
              refresh();
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {onDone ? (
        <QuietAction label={settled ? "Done" : "Set this up later"} onPress={onDone} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16 },
  lead: { color: palette.muted, fontSize: 16, lineHeight: 22 },
  rows: { backgroundColor: palette.tile, borderRadius: radius.tile, overflow: "hidden" },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.strong },
  callSection: { gap: 12 },
  callNotice: { color: palette.muted, fontSize: 14, lineHeight: 20 },
  phoneInput: {
    minHeight: 48,
    paddingHorizontal: 14,
    borderRadius: radius.tile,
    backgroundColor: palette.tile,
    color: palette.text,
    fontSize: 17,
  },
  callError: { color: palette.urgent, fontSize: 14, lineHeight: 20 },
  callActions: { gap: 6 },

  preview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    backgroundColor: palette.strong,
    borderRadius: radius.tile,
  },
  previewText: { flex: 1, gap: 2 },
  previewTitle: { color: palette.text, fontSize: 15, fontWeight: "600" },
  previewBody: { color: palette.muted, fontSize: 14, lineHeight: 19 },
  previewWhen: { color: palette.faint, fontSize: 13 },
});
