/**
 * A copy of `items` in a random order, every ordering equally likely.
 *
 * Fisher-Yates: the naive `sort(() => Math.random() - 0.5)` is not a shuffle at
 * all — it leaves the first items near the front far more often than chance.
 * On an arcade row three wide that is the difference between a fourth game
 * being behind an arrow half the time and being behind it almost always.
 */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = list[index];
    const other = list[swap];
    if (current === undefined || other === undefined) continue;
    list[index] = other;
    list[swap] = current;
  }
  return list;
}
