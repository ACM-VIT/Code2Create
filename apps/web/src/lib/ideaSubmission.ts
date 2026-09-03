export const initialIdeaClientMaximumLength = 300;

export function initialIdeaMaximumLength(policyMaximumLength: number) {
  return Math.min(policyMaximumLength, initialIdeaClientMaximumLength);
}
