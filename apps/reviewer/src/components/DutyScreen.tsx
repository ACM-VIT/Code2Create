import { Stack } from 'expo-router'
import type { ReactNode } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'

import { palette } from '@/theme'

/**
 * The chrome every screen behind the grid shares.
 *
 * The title sits inline, on the same row as the back chevron, rather than as a
 * large title on a line of its own: a duty screen is somewhere you are working,
 * not somewhere you are browsing, and the vertical space belongs to the work.
 * The bar is a real blurred iOS header, so content passes under it.
 */
export function DutyScreen({
  children,
  onRefresh,
  refreshing = false,
  title,
}: {
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
          headerLargeTitle: false,
          // Chevron only. The previous screen's title beside it is noise.
          headerBackButtonDisplayMode: 'minimal',
          // Transparent, not "the same colour as the page": iOS draws its own
          // header material over any backgroundColor you set, which is what
          // made the bar read as a separate surface hovering above the screen.
          // Nothing else in this app has one, so the header has none either.
          headerTransparent: true,
          headerShadowVisible: false,
          headerStyle: { backgroundColor: 'transparent' },
          headerTintColor: palette.text,
          headerTitleStyle: { color: palette.text, fontSize: 17, fontWeight: '600' },
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
  /* The floating tab bar overlays the scroll view, so the last control needs
     room to clear it rather than sitting underneath. */
  content: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 120, gap: 18 },
})
