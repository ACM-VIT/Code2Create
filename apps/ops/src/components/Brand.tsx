import type { ReactNode } from "react";

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
} from "./brand-paths";

export function BrandMark({ size = 96 }: { size?: number }) {
  const height = size * (114.677 / 104.99);
  return (
    <svg aria-hidden fill="none" height={height} viewBox={LOGO_VIEWBOX} width={size}>
      <defs>
        {FACETS.map((facet, index) => (
          <linearGradient id={`c2cf${index}`} key={index} x1="0" x2="0.35" y1="0" y2="1">
            <stop offset="0" stopColor={facet.from} />
            <stop offset="1" stopColor={facet.to} />
          </linearGradient>
        ))}
      </defs>
      <path d={RIM} fill="#FAFBFB" />
      <path d={PLATE} fill="#2C2C2C" stroke="#B44F76" strokeWidth={PLATE_STROKE_WIDTH} />
      {FACETS.map((facet, index) => (
        <path d={facet.d} fill={`url(#c2cf${index})`} key={index} />
      ))}
    </svg>
  );
}

export function BrandWordmark({ width = 260 }: { width?: number }) {
  return (
    <svg
      aria-label="Code2Create"
      height={width * (131 / 1032)}
      role="img"
      viewBox={WORDMARK_VIEWBOX}
      width={width}
    >
      {WORDMARK_GLYPHS.map((glyph, index) =>
        glyph.paths.map((d, pathIndex) => (
          <path d={d} fill={glyph.fill} key={`${index}-${pathIndex}`} />
        )),
      )}
    </svg>
  );
}

export function AcmMark({ size = 44 }: { size?: number }) {
  return (
    <svg aria-hidden fill="none" height={size} viewBox={ACM_MARK_VIEWBOX} width={size}>
      <path d={ACM_MARK_D} fill={ACM_MARK_FILL} />
    </svg>
  );
}

export function BrandBackdrop({ children }: { children: ReactNode }) {
  return <div className="brand-backdrop">{children}</div>;
}
