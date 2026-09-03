import { TrueSheet, type SheetDetent } from "@lodev09/react-native-true-sheet";
import Svg, { Path } from "react-native-svg";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from "react-native";

import { palette, radius } from "@/theme";

export function Section({
  action,
  children,
  lead,
  title,
}: {
  action?: ReactNode;
  children?: ReactNode;
  lead?: string;
  title: string;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action}
      </View>
      {lead ? <Text style={styles.lead}>{lead}</Text> : null}
      {children}
    </View>
  );
}

export function Card({
  children,
  onPress,
  selected = false,
}: {
  children: ReactNode;
  onPress?: () => void;
  selected?: boolean;
}) {
  const body = <View style={[styles.card, selected ? styles.cardSelected : null]}>{children}</View>;
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      {body}
    </Pressable>
  );
}

export function KeyValue({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.keyValue}>
      <Text style={styles.keyValueLabel}>{label}</Text>
      <Text style={styles.keyValueText}>{value}</Text>
    </View>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text style={styles.heading}>{children}</Text>;
}

export function Body({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

export function Meta({ children }: { children: ReactNode }) {
  return <Text style={styles.meta}>{children}</Text>;
}

export function Problem({ children }: { children: ReactNode }) {
  return <Text style={styles.problem}>{children}</Text>;
}

export function ErrorSheet({
  message,
  onClose,
  title = "That did not work",
}: {
  message: string | null;
  onClose: () => void;
  title?: string;
}) {
  return (
    <Sheet onClose={onClose} title={title} visible={message !== null}>
      <Text style={styles.errorSheetText}>{message}</Text>
      <Action label="Close" onPress={onClose} />
    </Sheet>
  );
}

export function Nothing({ children }: { children: string }) {
  return (
    <View style={styles.nothing}>
      <Text style={styles.nothingText}>{children}</Text>
    </View>
  );
}

export function Field({
  label,
  multiline = false,
  onChangeText,
  placeholder,
  value,
  ...rest
}: {
  editable?: boolean;
  label: string;
  maxLength?: number;
  multiline?: boolean;
  onChangeText: (value: string) => void;
  placeholder: string;
  value: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.faint}
        style={[styles.input, multiline ? styles.inputTall : null]}
        value={value}
        {...rest}
      />
    </View>
  );
}

export function ChipRow<Value extends string>({
  accent = palette.text,
  onSelect,
  options,
  selected,
  wrap = true,
}: {
  accent?: string;
  onSelect: (value: Value) => void;
  options: readonly (readonly [Value, string])[];
  selected: Value;
  wrap?: boolean;
}) {
  const Row = wrap ? View : ScrollView;
  return (
    <Row
      horizontal={!wrap}
      showsHorizontalScrollIndicator={false}
      {...(wrap ? { style: styles.chipRow } : { contentContainerStyle: styles.chipRow })}
    >
      {options.map(([value, label]) => {
        const on = value === selected;
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            key={value}
            onPress={() => onSelect(value)}
            style={[styles.chip, on ? { backgroundColor: accent } : null]}
          >
            <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{label}</Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

export function Lead({
  accent = palette.text,
  detail,
  unit,
  value,
}: {
  accent?: string;
  detail?: string;
  unit?: string;
  value: string;
}) {
  return (
    <View style={styles.lead2}>
      <Text
        allowFontScaling={false}
        numberOfLines={1}
        style={[styles.leadValue, { color: accent }]}
      >
        {value}
      </Text>
      {unit ? (
        <Text allowFontScaling={false} numberOfLines={1} style={styles.leadUnit}>
          {unit}
        </Text>
      ) : null}
      {detail ? <Text style={styles.leadDetail}>{detail}</Text> : null}
    </View>
  );
}

export type ScanVerdict = {
  colour: string;
  ink: string;
  tone: "ok" | "no" | "wait";
  name?: string;
  registration?: string;
  detail?: string;
};

function Verdict({ verdict }: { verdict: ScanVerdict | undefined }) {
  if (!verdict) return null;
  return (
    <View style={styles.verdict}>
      <View style={[styles.verdictMark, { backgroundColor: verdict.colour }]}>
        {verdict.tone === "wait" ? (
          <ActivityIndicator color={verdict.ink} size="large" />
        ) : (
          <Svg fill="none" height={40} viewBox="0 0 24 24" width={40}>
            <Path
              d={verdict.tone === "ok" ? "M4.5 12.5l5 5L19.5 7" : "M6.5 6.5l11 11M17.5 6.5l-11 11"}
              stroke={verdict.ink}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={3}
            />
          </Svg>
        )}
      </View>
      {verdict.name ? (
        <Text numberOfLines={2} style={styles.verdictName}>
          {verdict.name}
        </Text>
      ) : null}
      {verdict.registration ? (
        <Text numberOfLines={1} style={styles.verdictRegistration}>
          {verdict.registration}
        </Text>
      ) : null}
      {verdict.detail ? (
        <Text numberOfLines={5} style={styles.verdictDetail}>
          {verdict.detail}
        </Text>
      ) : null}
    </View>
  );
}

export function Viewfinder({ children, verdict }: { children: ReactNode; verdict?: ScanVerdict }) {
  return (
    <View style={styles.viewfinder}>
      {children}
      <View
        pointerEvents="none"
        style={[styles.viewfinderGuide, verdict ? { borderColor: verdict.colour } : null]}
      >
        <Verdict verdict={verdict} />
      </View>
    </View>
  );
}

function swallowSheetRace() {}

export function Sheet({
  children,
  detents = ["auto"],
  onClose,
  title,
  visible,
}: {
  children: ReactNode;
  detents?: SheetDetent[];
  onClose: () => void;
  title: string;
  visible: boolean;
}) {
  const sheet = useRef<TrueSheet>(null);
  // A sheet never reaches the top of the screen: the strip of dimmed
  // background left above it is what says "tap here to close".
  const { height: windowHeight } = useWindowDimensions();
  const sheetCeiling = Math.round(windowHeight * 0.85);
  // Mount the native sheet only while it is needed: an idle mounted sheet
  // sits invisibly over the screen and swallows every touch beneath it.
  const [mounted, setMounted] = useState(visible);
  // Adjust-state-on-render: mount as soon as the sheet is asked for.
  if (visible && !mounted) setMounted(true);

  useEffect(() => {
    // Every open is a fresh mount, so presenting is initialDetentIndex's job;
    // this effect only walks an open sheet back down.
    if (mounted && !visible) {
      void sheet.current?.dismiss().catch(swallowSheetRace);
    }
  }, [mounted, visible]);

  if (!mounted) return null;

  return (
    <View collapsable={false} pointerEvents="box-none" style={styles.sheetHost}>
      <TrueSheet
        backgroundColor={palette.background}
        cornerRadius={20}
        detents={detents}
        grabber
        initialDetentIndex={0}
        maxContentHeight={sheetCeiling}
        onDidDismiss={() => {
          onClose();
          setMounted(false);
        }}
        ref={sheet}
      >
        <View style={styles.sheetBody}>
          <Text style={styles.sheetTitle}>{title}</Text>
          {children}
        </View>
      </TrueSheet>
    </View>
  );
}

export function CheckRow({
  actionLabel = "Fix",
  consequence,
  met,
  onPress,
  title,
}: {
  actionLabel?: string;
  consequence: string;
  met: boolean | "unknown";
  onPress?: () => void | Promise<void>;
  title: string;
}) {
  const done = met === true;
  const actionable = onPress !== undefined && !done;
  return (
    <Pressable
      accessibilityRole={actionable ? "button" : undefined}
      accessibilityState={met === "unknown" ? {} : { checked: done }}
      disabled={!actionable}
      onPress={() => void onPress?.()}
      style={({ pressed }) => [styles.checkRow, pressed ? styles.pressed : null]}
    >
      {done ? (
        <View style={styles.checkBadge}>
          <Svg fill="none" height={14} viewBox="0 0 24 24" width={14}>
            <Path
              d="M4.5 12.5l5 5L19.5 7"
              stroke={palette.onJudging}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={3.4}
            />
          </Svg>
        </View>
      ) : (
        <View style={styles.checkHollow} />
      )}
      <View style={styles.checkText}>
        <Text style={styles.checkTitle}>{title}</Text>
        <Text style={styles.checkConsequence}>{done ? "Ready" : consequence}</Text>
      </View>
      {actionable ? (
        <View style={styles.checkChip}>
          <Text style={styles.checkChipText}>{actionLabel}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export function Row({
  danger = false,
  detail,
  label,
  onPress,
}: {
  danger?: boolean;
  detail?: string;
  label: string;
  onPress?: () => void;
}) {
  const body = (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={[styles.rowLabel, danger ? { color: palette.urgent } : null]}>{label}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      {onPress ? <Text style={styles.rowChevron}>›</Text> : null}
    </View>
  );
  if (!onPress) return body;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      {body}
    </Pressable>
  );
}

export function HeaderButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityLabel={label} accessibilityRole="button" hitSlop={12} onPress={onPress}>
      <Text style={styles.headerButton}>•••</Text>
    </Pressable>
  );
}

export function ScanSurface({
  camera,
  controls,
  result,
  verdict,
}: {
  camera: ReactNode;
  controls?: ReactNode;
  result?: ReactNode;
  verdict?: ScanVerdict;
}) {
  return (
    <View style={styles.scanSurface}>
      {camera}
      <View
        pointerEvents="none"
        style={[styles.scanGuide, verdict ? { borderColor: verdict.colour } : null]}
      >
        <Verdict verdict={verdict} />
      </View>

      <View pointerEvents="box-none" style={styles.scanTop}>
        {controls}
      </View>

      {result ? <View style={styles.scanResult}>{result}</View> : null}
    </View>
  );
}

export function ScoreRow({
  accent = palette.judging,
  disabled = false,
  ink = palette.onJudging,
  onSelect,
  scores,
  selected,
}: {
  accent?: string;
  disabled?: boolean;
  ink?: string;
  onSelect: (score: number) => void;
  scores: readonly number[];
  selected: number | undefined;
}) {
  return (
    <View style={styles.scoreRow}>
      {scores.map((score) => {
        const on = score === selected;
        return (
          <Pressable
            accessibilityLabel={String(score)}
            accessibilityRole="button"
            accessibilityState={{ disabled, selected: on }}
            disabled={disabled}
            key={score}
            onPress={() => onSelect(score)}
            style={({ pressed }) => [
              styles.score,
              on ? { backgroundColor: accent, borderColor: accent } : null,
              pressed ? styles.pressed : null,
            ]}
          >
            <Text style={[styles.scoreText, on ? { color: ink, fontWeight: "700" } : null]}>
              {score}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Progress({
  accent = palette.judging,
  done,
  total,
}: {
  accent?: string;
  done: number;
  total: number;
}) {
  const filled = total === 0 ? 0 : Math.max(0, Math.min(1, done / total));
  return (
    <View style={styles.progress}>
      {filled > 0 ? <View style={{ flex: filled, backgroundColor: accent }} /> : null}
      {filled > 0 && filled < 1 ? <View style={styles.progressGap} /> : null}
      {filled < 1 ? <View style={{ flex: 1 - filled, backgroundColor: palette.strong }} /> : null}
    </View>
  );
}

export function Action({
  accent = palette.judging,
  destructive = false,
  disabled = false,
  label,
  onPress,
}: {
  accent?: string;
  destructive?: boolean;
  disabled?: boolean;
  label: string;
  onPress: () => void | Promise<void>;
}) {
  const fill = disabled ? palette.tile : destructive ? palette.urgent : accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: fill },
        pressed ? styles.pressed : null,
      ]}
      onPress={() => void onPress()}
    >
      <Text
        numberOfLines={1}
        style={[styles.actionLabel, { color: disabled ? palette.faint : inkOn(fill) }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function inkOn(fill: string) {
  const known: Record<string, string> = {
    [palette.judging]: palette.onJudging,
    [palette.door]: palette.onDoor,
    [palette.hall]: palette.onHall,
    [palette.setup]: palette.onSetup,
    [palette.pulse]: palette.onPulse,
    [palette.urgent]: palette.onUrgent,
  };
  const ink = known[fill];
  if (ink) return ink;
  const hex = fill.replace("#", "");
  if (hex.length !== 6) return palette.text;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const luminance = 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  return luminance > 0.5 ? "#0A0A0B" : palette.text;
}

export function QuietAction({
  disabled = false,
  label,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void | Promise<void>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      hitSlop={8}
      onPress={() => void onPress()}
      style={({ pressed }) => [
        styles.quiet,
        disabled ? styles.dim : null,
        pressed ? styles.pressed : null,
      ]}
    >
      <Text style={styles.quietText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheetHost: { position: "absolute", top: 0, left: 0, width: 0, height: 0 },
  section: { gap: 10 },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { color: palette.text, fontSize: 20, fontWeight: "600", letterSpacing: -0.4 },
  lead: { color: palette.muted, fontSize: 16, lineHeight: 23 },

  card: { backgroundColor: palette.tile, borderRadius: radius.tile, padding: 16, gap: 8 },
  cardSelected: { backgroundColor: palette.strong },
  pressed: { opacity: 0.75 },
  dim: { opacity: 0.45 },

  keyValue: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    gap: 16,
  },
  keyValueLabel: { color: palette.muted, fontSize: 15 },
  keyValueText: { flexShrink: 1, color: palette.text, fontSize: 15, textAlign: "right" },

  heading: { color: palette.text, fontSize: 22, fontWeight: "600", letterSpacing: -0.4 },
  body: { color: palette.text, fontSize: 16, lineHeight: 23 },
  meta: { color: palette.muted, fontSize: 14 },
  problem: { color: palette.urgent, fontSize: 15, lineHeight: 21 },

  nothing: { paddingVertical: 34, alignItems: "center" },
  nothingText: { color: palette.faint, fontSize: 16, textAlign: "center" },

  field: { gap: 7 },
  fieldLabel: { color: palette.muted, fontSize: 14 },
  input: {
    height: 50,
    paddingHorizontal: 16,
    color: palette.text,
    fontSize: 17,
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
  },
  inputTall: { height: 108, paddingTop: 13, textAlignVertical: "top" },

  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 16,
    height: 40,
    justifyContent: "center",
    backgroundColor: palette.tile,
    borderRadius: radius.control,
  },
  chipText: { color: palette.text, fontSize: 15 },
  chipTextOn: { color: palette.background, fontWeight: "600" },

  sheetTitle: {
    color: palette.text,
    fontSize: 24,
    fontWeight: "600",
    letterSpacing: -0.5,
    marginBottom: 4,
  },
  sheetBody: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 40, gap: 16 },
  headerButton: { color: palette.text, fontSize: 20, letterSpacing: 1 },

  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 16,
    paddingHorizontal: 16,
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
  },
  rowText: { flex: 1, gap: 3 },
  rowLabel: { color: palette.text, fontSize: 17 },
  rowDetail: { color: palette.muted, fontSize: 14 },
  rowChevron: { color: palette.faint, fontSize: 22 },

  scanSurface: { flex: 1, backgroundColor: "#000" },
  scanGuide: {
    position: "absolute",
    top: "24%",
    right: "12%",
    bottom: "30%",
    left: "12%",
    borderWidth: 2,
    borderRadius: 22,
    borderColor: "rgba(255,255,255,0.55)",
  },
  scanTop: { position: "absolute", top: 12, right: 16, left: 16, gap: 12, alignItems: "center" },
  verdict: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingBottom: 44,
    paddingHorizontal: 22,
    gap: 12,
    backgroundColor: "rgba(0,0,0,0.74)",
    borderRadius: 20,
  },
  verdictMark: {
    width: 78,
    height: 78,
    borderRadius: 39,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  verdictName: {
    color: "#fff",
    fontSize: 23,
    fontWeight: "600",
    letterSpacing: -0.4,
    lineHeight: 28,
    textAlign: "center",
  },
  verdictRegistration: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 17,
    fontWeight: "600",
    letterSpacing: 2.2,
    textAlign: "center",
  },
  verdictDetail: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 16,
    lineHeight: 23,
    textAlign: "center",
  },
  scanResult: {
    position: "absolute",
    right: 0,
    bottom: 0,
    left: 0,
    padding: 20,
    paddingBottom: 34,
    gap: 10,
    backgroundColor: palette.background,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },

  lead2: { paddingBottom: 4 },
  leadValue: { fontSize: 52, fontWeight: "600", letterSpacing: -1.6, lineHeight: 54 },
  leadUnit: { color: palette.text, fontSize: 26, fontWeight: "500", letterSpacing: -0.6 },
  leadDetail: { marginTop: 10, color: palette.muted, fontSize: 16, lineHeight: 22 },

  viewfinder: {
    width: "100%",
    aspectRatio: 1.05,
    backgroundColor: "#000",
    overflow: "hidden",
    justifyContent: "center",
    borderRadius: radius.tile,
  },
  viewfinderGuide: {
    position: "absolute",
    top: "10%",
    right: "9%",
    bottom: "10%",
    left: "9%",
    borderWidth: 2,
    borderRadius: 22,
    borderColor: "rgba(255,255,255,0.55)",
  },
  brackets: { position: "absolute", top: 28, right: 28, bottom: 28, left: 28 },
  bracket: { position: "absolute", width: 46, height: 46 },
  bracketTopLeft: { top: 0, left: 0, borderTopWidth: 5, borderLeftWidth: 5 },
  bracketTopRight: { top: 0, right: 0, borderTopWidth: 5, borderRightWidth: 5 },
  bracketBottomLeft: { bottom: 0, left: 0, borderBottomWidth: 5, borderLeftWidth: 5 },
  bracketBottomRight: { bottom: 0, right: 0, borderBottomWidth: 5, borderRightWidth: 5 },

  scoreRow: { flexDirection: "row", gap: 8 },
  score: {
    flex: 1,
    height: 54,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: palette.strong,
    borderRadius: radius.pill,
  },
  scoreText: { color: palette.muted, fontSize: 19, fontWeight: "500" },

  progress: { flexDirection: "row", height: 8, borderRadius: 4, overflow: "hidden" },
  progressGap: { width: 3 },

  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 15,
    paddingHorizontal: 16,
  },
  checkBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: palette.judging,
    alignItems: "center",
    justifyContent: "center",
  },
  checkHollow: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: palette.strong,
  },
  checkChip: {
    height: 34,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    backgroundColor: palette.text,
    alignItems: "center",
    justifyContent: "center",
  },
  checkChipText: { color: palette.background, fontSize: 14, fontWeight: "600" },
  checkText: { flex: 1, gap: 2 },
  checkTitle: { color: palette.text, fontSize: 17, fontWeight: "500" },
  checkConsequence: { color: palette.muted, fontSize: 14, lineHeight: 19 },

  ringWrap: { alignItems: "center", paddingVertical: 18 },
  ring: {
    width: 232,
    height: 232,
    borderRadius: 116,
    borderWidth: 10,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    paddingHorizontal: 24,
  },
  ringLabel: {
    color: palette.text,
    fontSize: 28,
    fontWeight: "600",
    letterSpacing: -0.6,
    textAlign: "center",
  },
  ringDetail: { color: palette.muted, fontSize: 15, textAlign: "center" },

  errorSheetText: { color: palette.text, fontSize: 17, lineHeight: 24, marginBottom: 4 },
  action: {
    alignSelf: "stretch",
    height: 58,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    borderRadius: radius.control,
  },
  actionLabel: { fontSize: 17, fontWeight: "600", letterSpacing: -0.2 },
  quiet: {
    height: 52,
    borderRadius: radius.control,
    backgroundColor: palette.tile,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "stretch",
    paddingHorizontal: 16,
  },
  quietText: { color: palette.text, fontSize: 16, fontWeight: "500" },
});

export function DutyRing({
  accent,
  busy = false,
  detail,
  disabled = false,
  label,
  on,
  onPress,
}: {
  accent: string;
  busy?: boolean;
  detail?: string;
  disabled?: boolean;
  label: string;
  on: boolean;
  onPress: () => void | Promise<void>;
}) {
  return (
    <View style={styles.ringWrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy, disabled, selected: on }}
        disabled={disabled || busy}
        onPress={() => void onPress()}
        style={({ pressed }) => [
          styles.ring,
          { borderColor: on ? accent : palette.strong },
          on ? { backgroundColor: `${accent}14` } : null,
          disabled ? styles.dim : null,
          pressed ? styles.pressed : null,
        ]}
      >
        <Text style={[styles.ringLabel, on ? { color: accent } : null]}>{label}</Text>
        {detail ? <Text style={styles.ringDetail}>{detail}</Text> : null}
      </Pressable>
    </View>
  );
}
