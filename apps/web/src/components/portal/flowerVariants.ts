export const BLOOM_COUNT = 5;
export const TINT_COUNT = 4;
export const VARIANT_COUNT = BLOOM_COUNT * TINT_COUNT;

export function hashSeed(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function assignFlowerVariants(seeds: readonly string[]) {
  const variants = new Map<string, number>();
  const usedCombos = new Set<number>();
  const usedBlooms = new Set<number>();
  for (const seed of [...new Set(seeds)].toSorted()) {
    const preferred = hashSeed(seed) % VARIANT_COUNT;
    let picked = preferred;
    for (let probe = 0; probe < VARIANT_COUNT; probe += 1) {
      const combo = (preferred + probe) % VARIANT_COUNT;
      if (usedCombos.has(combo)) continue;
      picked = combo;
      if (usedBlooms.size >= BLOOM_COUNT || !usedBlooms.has(combo % BLOOM_COUNT)) break;
    }
    variants.set(seed, picked);
    usedCombos.add(picked);
    usedBlooms.add(picked % BLOOM_COUNT);
  }
  return variants;
}
