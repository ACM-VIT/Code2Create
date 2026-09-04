import { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { androidNativeTabBarHeight } from "@/lib/navigation-layout";
import { duty, palette, radius, space, tileAspectRatio, type, type DutyKey } from "@/theme";

export type DutyTile = {
  key: DutyKey;
  label: string;
  status: string;
  active?: boolean;
  resting?: boolean;
  icon: React.ReactNode;
  onPress: () => void;
};

export type DutyHeadline = {
  primary: string;
  secondary?: string;
  context: string;
  summary?: string;
};

export function DutyHome({
  headline,
  notice,
  tiles,
}: {
  headline: DutyHeadline;
  notice?: string;
  tiles: DutyTile[];
}) {
  const insets = useSafeAreaInsets();
  // Enable scrolling only when content extends behind the Android tab bar.
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const barHeight = Platform.OS === "android" ? androidNativeTabBarHeight + insets.bottom : 0;
  const overflows = viewportHeight > 0 && contentHeight + barHeight > viewportHeight + 1;
  const rows: DutyTile[][] = [];
  for (let index = 0; index < tiles.length; index += 2) {
    rows.push(tiles.slice(index, index + 2));
  }

  return (
    <View style={styles.root}>
      <SafeAreaView edges={["top"]} style={styles.body}>
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            Platform.OS === "android" && overflows
              ? { paddingBottom: 18 + androidNativeTabBarHeight + insets.bottom }
              : null,
          ]}
          contentInsetAdjustmentBehavior="automatic"
          scrollEnabled={overflows}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={(_, height) => setContentHeight(height)}
          onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
        >
          <View style={styles.head}>
            <Text allowFontScaling={false} numberOfLines={1} style={styles.value}>
              {headline.primary}
            </Text>
            {headline.secondary ? (
              <Text allowFontScaling={false} numberOfLines={1} style={styles.value}>
                {headline.secondary}
              </Text>
            ) : null}

            <View style={styles.identity}>
              <Text numberOfLines={1} style={styles.context}>
                {headline.context}
              </Text>
              {headline.summary ? (
                <Text numberOfLines={1} style={styles.summary}>
                  {headline.summary}
                </Text>
              ) : null}
            </View>
          </View>

          {notice ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>{notice}</Text>
            </View>
          ) : null}

          <View style={styles.grid}>
            {rows.map((row, rowIndex) => (
              <View key={rowIndex} style={styles.gridRow}>
                {row.map((tile) => (
                  <Tile key={tile.key} tile={tile} />
                ))}
                {row.length === 1 ? <View style={styles.tileFiller} /> : null}
              </View>
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

function Tile({ tile }: { tile: DutyTile }) {
  const { accent, ink } = duty[tile.key];
  const filled = tile.active === true;
  const statusColour = filled ? ink : tile.resting === true ? palette.muted : accent;
  return (
    <Pressable
      accessibilityLabel={`${tile.label}. ${tile.status}`}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.tile,
        filled ? { backgroundColor: accent } : null,
        pressed ? styles.tilePressed : null,
      ]}
      onPress={tile.onPress}
    >
      <Text numberOfLines={1} style={[styles.tileLabel, filled ? { color: ink } : null]}>
        {tile.label}
      </Text>
      <Text numberOfLines={2} style={[styles.tileStatus, { color: statusColour }]}>
        {tile.status}
      </Text>
      <View style={[styles.tileIcon, filled || tile.resting !== true ? null : styles.dim]}>
        {tile.icon}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  body: { flex: 1 },
  scroll: { paddingBottom: 18 },

  head: {
    paddingTop: 22,
    paddingBottom: 27,
    paddingHorizontal: space.text,
  },
  value: { color: palette.text, ...type.value },

  identity: { marginTop: 42 },
  context: { color: palette.muted, ...type.context },
  summary: { marginTop: 3, color: palette.text, ...type.summary },

  notice: {
    marginHorizontal: space.grid,
    marginBottom: space.tileGapY,
    padding: 14,
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
  },
  noticeText: { color: palette.urgent, fontSize: 15, lineHeight: 21 },

  grid: { paddingHorizontal: space.grid, gap: space.tileGapY },
  gridRow: { flexDirection: "row", gap: space.tileGapX },
  tile: {
    flex: 1,
    aspectRatio: tileAspectRatio,
    padding: space.tile,
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
  },
  tilePressed: { opacity: 0.75 },
  tileFiller: { flex: 1 },

  tileLabel: { color: palette.text, ...type.tileLabel },
  tileStatus: { marginTop: 2, ...type.tileStatus },
  dim: { opacity: 0.5 },
  tileIcon: { marginTop: "auto" },
});
