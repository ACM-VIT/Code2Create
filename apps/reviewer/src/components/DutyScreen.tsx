import { Stack } from "expo-router";
import { useState, type ReactNode } from "react";
import { Platform, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { androidNativeTabBarHeight } from "@/lib/navigation-layout";
import { screenHeader } from "@/lib/screen-header";
import { palette } from "@/theme";

export function DutyScreen({
  children,
  onRefresh,
  refreshing = false,
  scroll = true,
  title,
  underNativeTabs = false,
}: {
  children: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  scroll?: boolean;
  title: string;
  underNativeTabs?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const navigationInset =
    Platform.OS === "android"
      ? insets.bottom + (underNativeTabs ? androidNativeTabBarHeight : 0)
      : 0;
  const bottomPadding =
    styles.content.paddingBottom + navigationInset;
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
          contentContainerStyle={[styles.content, { paddingBottom: bottomPadding }]}
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
        <View style={[styles.fixedContent, { paddingBottom: navigationInset }]}>{children}</View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  scroll: { flex: 1 },
  fixedContent: { flex: 1 },
  content: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 28, gap: 18 },
});
