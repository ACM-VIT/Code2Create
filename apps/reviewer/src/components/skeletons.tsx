import { useEffect, useState } from "react";
import { Animated, StyleSheet, View } from "react-native";

import { palette, radius, space } from "@/theme";

function Bone({
  height = 18,
  radius: corner = 6,
  style,
  width,
}: {
  height?: number;
  radius?: number;
  style?: object;
  width?: number | `${number}%`;
}) {
  return (
    <View
      style={[
        styles.bone,
        { height, borderRadius: corner },
        width === undefined ? null : { width },
        style ?? null,
      ]}
    />
  );
}

function Breathing({ children }: { children: React.ReactNode }) {
  const [pulse] = useState(() => new Animated.Value(0.45));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.85,
          duration: 780,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 780,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return <Animated.View style={{ opacity: pulse }}>{children}</Animated.View>;
}

export function JudgingSkeleton() {
  return (
    <Breathing>
      <View style={styles.stack}>
        <Bone height={30} width="62%" />
        <Bone height={16} width="38%" />
        <View style={styles.gap} />
        {[0, 1, 2].map((row) => (
          <View key={row} style={styles.checkRow}>
            <View style={styles.checkText}>
              <Bone height={17} width="70%" />
              <Bone height={13} width="45%" />
            </View>
            <Bone height={22} radius={11} width={22} />
          </View>
        ))}
        <View style={styles.gap} />
        <Bone height={58} radius={radius.control} />
      </View>
    </Breathing>
  );
}

export function DoorSkeleton() {
  return (
    <View style={styles.doorRoot}>
      <Breathing>
        <View style={styles.doorFill}>
          <View style={styles.doorControls}>
            <Bone height={40} radius={radius.pill} width="72%" />
          </View>
          <View style={styles.doorGuide} />
        </View>
      </Breathing>
    </View>
  );
}

export function HallSkeleton() {
  return (
    <View style={styles.hallRoot}>
      <Breathing>
        <View style={styles.stack}>
          <Bone height={26} width="48%" />
          <View style={styles.gap} />
          <View style={styles.hallGrid}>
            {Array.from({ length: 12 }, (_, index) => (
              <Bone height={62} key={index} radius={radius.tile} style={styles.hallCell} />
            ))}
          </View>
        </View>
      </Breathing>
    </View>
  );
}

export function PulseSkeleton() {
  return (
    <Breathing>
      <View style={styles.stack}>
        <Bone height={52} width="44%" />
        <Bone height={16} width="30%" />
        <View style={styles.gap} />
        {[0, 1, 2, 3].map((row) => (
          <View key={row} style={styles.listRow}>
            <Bone height={17} width={`${72 - row * 9}%`} />
            <Bone height={13} width={`${48 - row * 6}%`} />
          </View>
        ))}
      </View>
    </Breathing>
  );
}

export function CaseListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Breathing>
      <View style={styles.stack}>
        {Array.from({ length: rows }, (_, index) => (
          <View key={index} style={styles.listRow}>
            <Bone height={17} width={`${78 - index * 7}%`} />
            <Bone height={13} width={`${52 - index * 5}%`} />
          </View>
        ))}
      </View>
    </Breathing>
  );
}

const styles = StyleSheet.create({
  bone: { backgroundColor: palette.tile },
  stack: { gap: 10, paddingTop: 4 },
  gap: { height: 12 },

  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 10,
  },
  checkText: { flex: 1, gap: 7 },

  listRow: { gap: 7, paddingVertical: 11 },

  doorRoot: { flex: 1, backgroundColor: "#000" },
  doorFill: { flex: 1 },
  doorControls: { position: "absolute", top: 12, right: 16, left: 16, alignItems: "center" },
  doorGuide: {
    position: "absolute",
    top: "24%",
    right: "12%",
    bottom: "30%",
    left: "12%",
    borderWidth: 2,
    borderRadius: 22,
    borderColor: "rgba(255,255,255,0.28)",
  },

  hallRoot: { flex: 1, paddingHorizontal: space.grid },
  hallGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  hallCell: { width: "31%" },
});
