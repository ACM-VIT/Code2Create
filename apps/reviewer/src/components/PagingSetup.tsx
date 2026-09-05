import { reviewerCallConsentPolicyVersion } from "@code2create/domain";
import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQueries } from "convex/react";
import { randomUUID } from "expo-crypto";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";

import { Action, CheckRow, QuietAction } from "@/components/ui";
import { describeError } from "@/lib/errors";
import { openPagingSetting } from "@/lib/paging-settings";
import {
  pagingReadiness,
  type PagingReadinessCheck,
} from "@/lib/push-notifications";
import { useDeviceCheck } from "@/lib/use-device-check";
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
  requestPermission: (onPermissionChecked?: () => void) => Promise<void>;
  tokenRejected?: boolean;
  tokenMissing?: boolean;
}) {
  const {
    value: checks,
    error: checkError,
    refresh,
  } = useDeviceCheck(
    pagingReadiness,
    "Paging settings could not be checked. Try again or reopen Settings.",
  );
  const [setupError, setSetupError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [callBusy, setCallBusy] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [phoneOverride, setPhoneOverride] = useState<string | null>(null);
  // Call consent is optional. A denied/failed query must not crash phone setup.
  const {
    consent,
  }: {
    consent?: FunctionReturnType<typeof api.outboundCallConsents.mine> | Error;
  } = useQueries({
    consent: { query: api.outboundCallConsents.mine, args: { eventSlug } },
  });
  const consentError =
    consent instanceof Error
      ? describeError(
          consent,
          "Review calls are unavailable. Ask the review desk to check your access.",
        )
      : null;
  const callConsent = consent instanceof Error ? undefined : consent;
  const saveCallConsent = useMutation(
    api.outboundCallConsents.saveReviewerConsent,
  );

  const openSetting = async (fix: NonNullable<PagingReadinessCheck["fix"]>) => {
    setSetupError(null);
    try {
      await openPagingSetting(fix);
      await refresh();
    } catch (caught) {
      setSetupError(
        describeError(
          caught,
          "Settings could not be opened. Open this app’s settings from your phone Settings.",
        ),
      );
    }
  };

  const permission = checks?.find((check) => check.key === "permission");
  const settled = permission?.met === true;
  const callsEnabled = callConsent?.state === "granted";
  const phone =
    phoneOverride ??
    callConsent?.destinationPhoneE164 ??
    callConsent?.suggestedPhoneE164 ??
    "+91";

  const changeCallConsent = async (state: "granted" | "revoked") => {
    if (!callConsent || callBusy) return;
    setCallBusy(true);
    setCallError(null);
    try {
      await saveCallConsent({
        eventSlug,
        state,
        consentPolicyVersion: reviewerCallConsentPolicyVersion,
        ...(state === "granted" ? { destinationPhone: phone } : {}),
        expectedVersion: callConsent.version,
        clientOperationId: randomUUID(),
      });
      setPhoneOverride(null);
    } catch (caught: unknown) {
      setCallError(
        describeError(caught, "The phone fallback could not be changed."),
      );
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

      <Text style={styles.lead}>
        A panel short a reviewer waits on this phone.
      </Text>

      {checkError ? (
        <View>
          <Text style={styles.callError}>{checkError}</Text>
          <QuietAction label="Check again" onPress={() => void refresh()} />
        </View>
      ) : null}
      {setupError ? <Text style={styles.callError}>{setupError}</Text> : null}

      <View style={styles.rows}>
        {tokenRejected || tokenMissing ? (
          <CheckRow
            consequence={
              tokenRejected
                ? "This phone was refused by the push service — allow notifications again, or reinstall"
                : "This phone has no address to be paged at yet — reopen this after a moment online"
            }
            met={false}
            onPress={() => void openSetting("notification_settings")}
            title="Reachable"
          />
        ) : null}
        {(checks ?? []).map((check, index) => {
          const fix = check.fix;
          return (
            <View
              key={check.key}
              style={index === 0 ? undefined : styles.divider}
            >
              <CheckRow
                consequence={check.consequence}
                met={check.met}
                title={check.title}
                {...(fix
                  ? {
                      onPress: () => openSetting(fix),
                    }
                  : {})}
              />
            </View>
          );
        })}
      </View>

      {consentError ? (
        <View style={styles.callSection}>
          <Text style={styles.callError}>{consentError}</Text>
          <Text style={styles.callNotice}>
            You can still finish notification setup and register this phone.
          </Text>
        </View>
      ) : (
        <View style={styles.callSection}>
          <CheckRow
            consequence={
              callConsent === undefined
                ? "Checking your call setting"
                : callsEnabled
                  ? `Calls go to ${callConsent.destinationPhoneE164}`
                  : callConsent.state === "needs_confirmation"
                    ? "Confirm the updated notice to allow shift reminders and substitute calls"
                    : "Optional reminders and substitute calls; respond in the app"
            }
            met={callsEnabled}
            title="Review calls"
          />
          <Text style={styles.callNotice}>
            Code2Create may call before your confirmed shift and when you are
            needed as a substitute. Calls ask you to open the app to clock in or
            respond.
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
              label={callBusy ? "Saving…" : "Allow review calls"}
              onPress={() => void changeCallConsent("granted")}
            />
          )}
        </View>
      )}

      {!settled || tokenMissing || tokenRejected ? (
        <Action
          accent={palette.judging}
          disabled={busy}
          label={
            busy
              ? "Checking…"
              : settled
                ? "Register notifications"
                : "Allow notifications"
          }
          onPress={async () => {
            setBusy(true);
            setSetupError(null);
            try {
              await requestPermission(() => void refresh());
              await refresh();
            } catch (caught) {
              setSetupError(
                describeError(
                  caught,
                  "Notification setup could not be completed. Try again.",
                ),
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}

      {onDone ? (
        <QuietAction
          label={settled ? "Done" : "Set this up later"}
          onPress={onDone}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 16 },
  lead: { color: palette.muted, fontSize: 16, lineHeight: 22 },
  rows: {
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
    overflow: "hidden",
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.strong,
  },
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
