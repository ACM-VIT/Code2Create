import { Stack } from 'expo-router'
import type { ReactNode } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'

import { palette } from '@/theme'

/**
 * The chrome every screen behind the grid shares: a real iOS large title that
 * collapses into a blurred bar as you scroll, and one scroll container so the
 * panels underneath never nest their own.
 *
 * `back` is for pushed duty routes, which set their header on the root stack;
 * tab screens inherit theirs from the stack inside their own tab.
 */
export function DutyScreen({
  back = false,
  children,
  onRefresh,
  refreshing = false,
  title,
}: {
  back?: boolean
  children: ReactNode
  onRefresh?: () => void
  refreshing?: boolean
  title: string
}) {
  return (
    <View style={styles.root}>
      <Stack.Screen
        options={{
          headerShown: true,
          title,
          // Chevron only. The previous screen's title beside it is noise.
          headerBackButtonDisplayMode: 'minimal',
          ...(back
            ? {
                headerLargeTitle: true,
                headerTransparent: true,
                headerBlurEffect: 'systemChromeMaterialDark' as const,
                headerStyle: { backgroundColor: 'transparent' },
                headerTintColor: palette.text,
                headerLargeTitleStyle: { color: palette.text },
                headerTitleStyle: { color: palette.text },
              }
            : {}),
        }}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        refreshControl={
          onRefresh
            ? <RefreshControl onRefresh={onRefresh} refreshing={refreshing} tintColor={palette.muted} />
            : undefined
        }
        style={styles.scroll}
      >
        {children}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: palette.background },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 120, gap: 16 },
})
