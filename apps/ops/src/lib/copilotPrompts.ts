/** Starting points that map onto the copilot's event-bound reads. */
export const copilotSuggestedPrompts = [
  'What needs attention right now?',
  'Which review panels are behind, and why?',
  'How is check-in going?',
  'Is the help desk keeping up?',
] as const

/** Router state carried from the overview composer into the Ask view. */
export function promptFromNavigationState(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('prompt' in state)) return undefined
  const { prompt } = state
  return typeof prompt === 'string' && prompt.trim().length > 0 ? prompt.trim() : undefined
}
