/** Technical per-response ceiling. Traversals continue until every row is read. */
export const operationsAutonomyReadPageMaximumBytes = 64 * 1_024;

/** Query work stays bounded even when individual rows are very small. */
export const operationsAutonomyReadPageMaximumRows = 4;
