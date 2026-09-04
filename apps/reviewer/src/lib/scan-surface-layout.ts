const horizontalGuideRatio = 0.76;
const verticalGuidePadding = 24;
const minimumUsefulGuideSize = 96;

export function scanGuideSize(area: { width: number; height: number }) {
  if (
    !Number.isFinite(area.width) ||
    !Number.isFinite(area.height) ||
    area.width <= 0 ||
    area.height <= 0
  ) {
    return 0;
  }
  const size = Math.floor(
    Math.min(area.width * horizontalGuideRatio, area.height - verticalGuidePadding),
  );
  return size >= minimumUsefulGuideSize ? size : 0;
}
