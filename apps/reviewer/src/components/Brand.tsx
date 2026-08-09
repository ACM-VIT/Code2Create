import { Image, StyleSheet, View } from 'react-native'
import Svg, { Defs, G, LinearGradient, Path, Rect, Stop } from 'react-native-svg'

import { palette } from '@/theme'

/**
 * The event's own marks, taken from the published brand file.
 *
 * They exist so the one screen a person sees before they have any duties looks
 * like this event rather than like a login form: a night sky over the hills,
 * a cherry tree in blossom, and the hexagon a thousand people will have on
 * their lanyard.
 */

/**
 * The night the event runs in.
 *
 * The brand file runs this from near-black through plum to blossom, but puts
 * the two pink stops past the bottom of the frame — so a screen only ever
 * shows the dark two-thirds and the plum it has turned by the bottom edge.
 * These are those visible stops, with the off-screen ones resolved.
 */
export const brandGradient = [
  { colour: '#0C0004', at: 0 },
  { colour: '#0C0004', at: 0.71 },
  { colour: '#6D2B42', at: 1 },
] as const

/** The hexagon, drawn at whatever size it is given. */
export function BrandMark({ size = 96 }: { size?: number }) {
  const height = size * (209.343 / 191.675)
  return (
    <Svg fill="none" height={height} viewBox="0 0 191.675 209.343" width={size}>
      <Path
        d="M86.7061 2.37499L9.13162 45.8477C3.47534 49.0143 0 54.8658 0 61.1991V148.144C0 154.478 3.47534 160.329 9.13162 163.496L86.7061 206.968C92.3624 210.135 99.313 210.135 104.969 206.968L182.544 163.496C188.2 160.329 191.675 154.478 191.675 148.144V61.1991C191.675 54.8658 188.2 49.0143 182.544 45.8477L104.987 2.37499C99.3308 -0.791664 92.3624 -0.791664 86.7061 2.37499Z"
        fill="#FAFBFB"
      />
      {/* The inner solid is drawn on the same 191.675 grid the outer hexagon
          uses, so the white edge stays an even rim at every size. */}
      <G transform="translate(6.2 5.6)">
        <Path
          d="M179.051 151.311V58.0496L95.8377 11.4103L12.6247 58.0496V151.311L95.8377 197.933L179.051 151.311Z"
          fill="#2C2C2C"
          stroke="#B44F76"
          strokeMiterlimit={10}
          strokeWidth={0.438421}
        />
        <Path d="M95.9441 38.0171L36.5088 71.3186V71.6112L95.9441 104.655V38.0171Z" fill="#D884A2" />
        <Path
          d="M95.9441 104.655V171.292L95.9973 171.309L155.468 137.973V137.732L95.9441 104.655Z"
          fill="#D884A2"
        />
        <Path d="M95.9441 104.655L36.5088 71.6112V137.939L95.9441 104.655Z" fill="#B44F76" />
        <Path
          d="M36.5088 137.939V137.973L95.9441 171.292V104.655L36.5088 137.939Z"
          fill="#E3A9BF"
        />
        <Path d="M155.504 71.3014L95.9441 104.689V37.9827L155.504 71.3014Z" fill="#F1CEDF" />
      </G>
    </Svg>
  )
}

/**
 * The whole backdrop: gradient, hills on the horizon, and the tree leaning in
 * from the left with its petals falling across the screen.
 *
 * Everything here is decoration and is marked as such, so a screen reader
 * reaches the sign-in button without walking through a landscape.
 */
export function BrandBackdrop({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.backdrop}>
      <Svg height="100%" style={StyleSheet.absoluteFill} width="100%">
        <Defs>
          <LinearGradient id="night" x1="0" x2="0" y1="0" y2="1">
            {brandGradient.map((stop) => (
              <Stop key={stop.at} offset={stop.at} stopColor={stop.colour} />
            ))}
          </LinearGradient>
        </Defs>
        <Rect fill="url(#night)" height="100%" width="100%" x="0" y="0" />
      </Svg>

      {/* The tree hangs from the top-left, as it does on every poster. It is
          wider than the screen on purpose: the trunk anchors the corner and the
          canopy runs off the right edge rather than being shrunk to fit. */}
      <Image
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        source={require('../../assets/brand/blossom-tree.png')}
        style={styles.tree}
      />

      <Image
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        source={require('../../assets/brand/hills.png')}
        style={styles.hills}
      />

      {/* The landscape is busiest exactly where the words sit. This settles the
          lower half back down so type has something quiet to rest on. */}
      <Svg height="55%" style={styles.scrim} width="100%">
        <Defs>
          <LinearGradient id="scrim" x1="0" x2="0" y1="0" y2="1">
            <Stop offset={0} stopColor="#0C0004" stopOpacity={0} />
            <Stop offset={0.55} stopColor="#0C0004" stopOpacity={0.72} />
            <Stop offset={1} stopColor="#0C0004" stopOpacity={0.92} />
          </LinearGradient>
        </Defs>
        <Rect fill="url(#scrim)" height="100%" width="100%" x="0" y="0" />
      </Svg>

      {children}
    </View>
  )
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', right: 0, bottom: 0, left: 0 },
  backdrop: { flex: 1, backgroundColor: palette.background, overflow: 'hidden' },
  /**
   * Big enough that the canopy leaves the top of the screen and the trunk runs
   * the length of the left edge, so it reads as a tree you are standing under
   * rather than a picture pinned to the top.
   *
   * The image ends in a carpet of fallen petals, which would otherwise cut off
   * in a hard line across the middle of the screen. It is sized so that edge
   * lands inside the ridge below, where the two blend into each other.
   */
  tree: {
    position: 'absolute',
    top: -40,
    left: -170,
    width: 850,
    height: 676,
    opacity: 0.92,
  },
  /* Low and faint: the ridge should settle the bottom of the screen, not
     compete with the words sitting on top of it. */
  hills: {
    position: 'absolute',
    right: -40,
    bottom: -150,
    left: -40,
    height: 460,
    opacity: 0.5,
  },
})
