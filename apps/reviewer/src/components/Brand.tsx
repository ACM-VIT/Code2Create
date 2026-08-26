import { StyleSheet, View } from 'react-native'
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg'

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
  return <View style={styles.backdrop}>{children}</View>
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: palette.background },
})
