import { StyleSheet, Text, View } from "react-native";

import { Action, CheckRow } from "@/components/ui";
import { palette } from "@/theme";

export function ReviewerSetup({
  busy,
  cameraReady,
  requiresCamera,
  requiresPaging,
  draftsReady,
  onOpenPaging,
  onRegister,
  onRequestCamera,
  pagingReady,
  ready,
  registerLabel,
}: {
  busy: boolean;
  cameraReady: boolean;
  requiresCamera: boolean;
  requiresPaging: boolean;
  draftsReady: boolean;
  onOpenPaging: () => void;
  onRegister: () => void | Promise<void>;
  onRequestCamera: () => void | Promise<void>;
  pagingReady: boolean;
  ready: boolean;
  registerLabel: string;
}) {
  const checks = [
    {
      title: "Camera",
      consequence: "Scan the team’s review code",
      required: requiresCamera,
      met: cameraReady,
      actionLabel: "Allow",
      onPress: onRequestCamera,
    },
    {
      title: "Review alerts",
      consequence: "Get panel requests on this phone",
      required: requiresPaging,
      met: pagingReady,
      actionLabel: "Set up",
      onPress: onOpenPaging,
    },
    {
      title: "Offline scores",
      consequence: "Save scores if the connection drops",
      required: true,
      met: draftsReady,
    },
  ] as const;

  const requiredChecks = checks.filter((check) => check.required);
  const done = requiredChecks.filter((check) => check.met).length;

  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <Text style={styles.title}>Set up this phone</Text>
        <Text style={styles.subtitle}>
          {done === requiredChecks.length
            ? "Ready to join your panel."
            : `${done} of ${requiredChecks.length} ready`}
        </Text>
      </View>

      <View style={styles.meter}>
        {requiredChecks.map((check) => (
          <View
            key={check.title}
            style={[styles.meterSegment, check.met ? styles.meterDone : null]}
          />
        ))}
      </View>

      <View style={styles.rows}>
        {checks.map((check, index) => (
          <View key={check.title}>
            {index > 0 ? <View style={styles.divider} /> : null}
            <CheckRow
              consequence={check.consequence}
              met={check.met}
              title={`${check.title}${check.required ? "" : " (optional)"}`}
              {...("onPress" in check
                ? { actionLabel: check.actionLabel, onPress: check.onPress }
                : {})}
            />
          </View>
        ))}
      </View>

      <View style={styles.push} />
      <Action
        accent={palette.judging}
        disabled={busy || !ready}
        label={registerLabel}
        onPress={onRegister}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, paddingTop: 10 },
  push: { flexGrow: 1 },
  head: { gap: 8, paddingHorizontal: 4 },
  title: {
    color: palette.text,
    fontSize: 28,
    fontWeight: "600",
    letterSpacing: -0.6,
  },
  subtitle: { color: palette.muted, fontSize: 16, lineHeight: 22 },
  meter: { flexDirection: "row", gap: 6, marginTop: 20, paddingHorizontal: 4 },
  meterSegment: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: palette.tile,
  },
  meterDone: { backgroundColor: palette.judging },
  rows: { marginTop: 18 },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: palette.strong,
    marginLeft: 56,
  },
});
