export const JOURNEY_MASTER_DURATION = 290;

export const JOURNEY_SCROLL_SEGMENTS = [
  { from: 0, to: 14, distanceScale: 1 },
  { from: 14, to: 71, distanceScale: 2 },
  { from: 71, to: 103, distanceScale: 1 },
  { from: 103, to: 150, distanceScale: 2 },
  { from: 150, to: JOURNEY_MASTER_DURATION, distanceScale: 1 },
] as const;

export function journeyScrollTime(masterTime: number) {
  const bounded = Math.max(0, Math.min(JOURNEY_MASTER_DURATION, masterTime));

  return JOURNEY_SCROLL_SEGMENTS.reduce((total, segment) => {
    const covered = Math.max(0, Math.min(bounded, segment.to) - segment.from);
    return total + covered * segment.distanceScale;
  }, 0);
}

export const JOURNEY_SCROLL_DURATION = journeyScrollTime(JOURNEY_MASTER_DURATION);

export function journeyScrollProgress(masterTime: number) {
  return journeyScrollTime(masterTime) / JOURNEY_SCROLL_DURATION;
}

export function journeyMasterTime(scrollProgress: number) {
  let remaining = Math.max(0, Math.min(1, scrollProgress)) * JOURNEY_SCROLL_DURATION;

  for (const segment of JOURNEY_SCROLL_SEGMENTS) {
    const weightedDuration = (segment.to - segment.from) * segment.distanceScale;
    if (remaining <= weightedDuration) {
      return segment.from + remaining / segment.distanceScale;
    }
    remaining -= weightedDuration;
  }

  return JOURNEY_MASTER_DURATION;
}
