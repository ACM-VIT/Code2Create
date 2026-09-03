import { Stack } from "expo-router";
import { useState, type ReactNode } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";

import { screenHeader } from "@/lib/screen-header";
import { palette } from "@/theme";

export function DutyScreen({
  children,
  onRefresh,
  refreshing = false,
  scroll = true,
  title,
}: {
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  scroll?: boolean;
  title: string;
}) {
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
          ...screenHeader,
          headerShown: true,
          title,
        }}
      />
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.content}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          onContentSizeChange={(_, height) => setContentHeight(height)}
          onLayout={(event) => setViewportHeight(event.nativeEvent.layout.height)}
          refreshControl={
            onRefresh ? (
              <RefreshControl
                onRefresh={onRefresh}
                refreshing={refreshing}
                tintColor={palette.muted}
              />
            ) : undefined
          }
          // A screen that fits should sit still; pull-to-refresh screens
          // keep the gesture regardless.
          scrollEnabled={onRefresh !== undefined || contentHeight > viewportHeight + 1}
          style={styles.scroll}
        >
          {children}
        </ScrollView>
      ) : (
        children
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  scroll: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 28, gap: 18 },
});
