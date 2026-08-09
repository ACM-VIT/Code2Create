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
  scroll = true,
  title,
}: {
  children: ReactNode
  onRefresh?: () => void
  refreshing?: boolean
  /**
   * False when the duty owns its whole frame. A camera boxed inside a padded
   * scrolling form is a preview; a camera that fills the screen is a scanner.
   */
  scroll?: boolean
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
          // Transparent only where content scrolls under it. A screen that
          // fills its own frame has nothing to scroll, and a transparent header
          // over a full-bleed camera lets the camera swallow taps meant for the
          // header's own controls.
          headerTransparent: scroll,
          headerShadowVisible: false,
          headerStyle: scroll
            ? { backgroundColor: 'transparent' }
            : { backgroundColor: palette.background },
          headerTintColor: palette.text,
          headerTitleStyle: { color: palette.text, fontSize: 17, fontWeight: '600' },
        }}
      />
      {scroll ? (
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
      ) : (
        children
      )}
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
