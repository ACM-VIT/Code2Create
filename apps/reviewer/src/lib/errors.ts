import { ConvexError } from 'convex/values'

/** Marks client-side refusal text as safe to show to an operator. */
export class OperatorError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OperatorError'
  }
}

export function describeError(caught: unknown, fallback: string) {
  if (caught instanceof OperatorError && caught.message.trim()) return caught.message
  if (caught instanceof Error && /network request failed|failed to fetch|fetch failed/iu.test(caught.message)) {
    return 'The server could not be reached. Check this phone’s connection and try again.'
  }
  if (caught instanceof ConvexError) {
    const data: unknown = caught.data
    if (typeof data === 'string' && data.trim()) return data
    if (data !== null && typeof data === 'object' && 'message' in data) {
      const message = data.message
      if (typeof message === 'string' && message.trim()) return message
    }
  }
  return fallback
}
