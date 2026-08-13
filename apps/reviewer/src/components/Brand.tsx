import { Image, StyleSheet, View } from 'react-native'
import Svg, { Defs, LinearGradient, Path, Rect, Stop } from 'react-native-svg'

import {
  ACM_MARK_D,
  ACM_MARK_FILL,
  ACM_MARK_VIEWBOX,
  FACETS,
  LOGO_VIEWBOX,
  PLATE,
  PLATE_STROKE_WIDTH,
  RIM,
  WORDMARK_GLYPHS,
  WORDMARK_VIEWBOX,
} from '@/components/brand-paths'
import { palette } from '@/theme'

export const brandGradient = [
  { colour: '#0C0004', at: 0 },
  { colour: '#0C0004', at: 0.71 },
  { colour: '#6D2B42', at: 1 },
] as const

export function BrandMark({ size = 96 }: { size?: number }) {
  const height = size * (114.677 / 104.99)
  return (
    <Svg fill="none" height={height} viewBox={LOGO_VIEWBOX} width={size}>
      <Defs>
        {FACETS.map((facet, index) => (
          <LinearGradient id={`c2cf${index}`} key={index} x1="0" x2="0.35" y1="0" y2="1">
            <Stop offset="0" stopColor={facet.from} />
            <Stop offset="1" stopColor={facet.to} />
          </LinearGradient>
        ))}
      </Defs>
      <Path d={RIM} fill="#FAFBFB" />
      <Path d={PLATE} fill="#2C2C2C" stroke="#B44F76" strokeWidth={PLATE_STROKE_WIDTH} />
      {FACETS.map((facet, index) => (
        <Path d={facet.d} fill={`url(#c2cf${index})`} key={index} />
      ))}
    </Svg>
  )
}

export function BrandWordmark({ width = 260 }: { width?: number }) {
  return (
    <Svg height={width * (131 / 1032)} viewBox={WORDMARK_VIEWBOX} width={width}>
      {WORDMARK_GLYPHS.map((glyph, index) =>
        glyph.paths.map((d, pathIndex) => (
          <Path d={d} fill={glyph.fill} key={`${index}-${pathIndex}`} />
        )),
      )}
    </Svg>
  )
}

export function AcmMark({ size = 44 }: { size?: number }) {
  return (
    <Svg fill="none" height={size} viewBox={ACM_MARK_VIEWBOX} width={size}>
      <Path d={ACM_MARK_D} fill={ACM_MARK_FILL} />
    </Svg>
  )
}

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
  // Keep the image base below tall screens.
  tree: {
    position: 'absolute',
    top: -40,
    left: -170,
    height: '108%',
    aspectRatio: 850 / 676,
    opacity: 0.92,
  },
  hills: {
    position: 'absolute',
    right: -40,
    bottom: -150,
    left: -40,
    height: 460,
    opacity: 0.5,
  },
})
