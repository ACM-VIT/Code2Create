export type SupportCategoryKind = "open" | "closed";

const maximumRolloverCategoryIndex = 99;
const maximumChannelsPerCategory = 50;

export function supportCategoryHasSpace(childCount: number) {
  if (!Number.isSafeInteger(childCount) || childCount < 0) {
    throw new RangeError("Discord support category child counts must be non-negative integers.");
  }
  return childCount < maximumChannelsPerCategory;
}

export function supportCategoryRolloverName(kind: SupportCategoryKind, index: number) {
  if (!Number.isSafeInteger(index) || index < 2 || index > maximumRolloverCategoryIndex) {
    throw new RangeError("Discord support rollover category indexes must be between 2 and 99.");
  }
  return `c2c-support-${kind}-${String(index).padStart(2, "0")}`;
}

export function supportCategoryRolloverIndex(
  kind: SupportCategoryKind,
  name: string,
): number | null {
  const match = /^c2c-support-(open|closed)-(\d{2})$/u.exec(name);
  if (!match || match[1] !== kind) return null;
  const index = Number(match[2]);
  return index >= 2 && index <= maximumRolloverCategoryIndex ? index : null;
}

export function nextSupportCategoryRolloverIndex(
  kind: SupportCategoryKind,
  categoryNames: readonly string[],
) {
  const highest = categoryNames.reduce((current, name) => {
    const index = supportCategoryRolloverIndex(kind, name);
    return index === null ? current : Math.max(current, index);
  }, 1);
  const next = highest + 1;
  if (next > maximumRolloverCategoryIndex) {
    throw new Error("Discord support exhausted its rollover category range.");
  }
  return next;
}
