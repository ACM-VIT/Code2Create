export function reviewWorkspaceKey(review: { id: string; scorecard: { id: string } }) {
  return `${review.id}:${review.scorecard.id}`
}
