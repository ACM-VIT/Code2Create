import { ConvexError } from 'convex/values'

const fallbackMessage = 'Something went wrong. Try again.'

export function convexErrorCode(error: unknown) {
  if (!(error instanceof ConvexError)) return null
  if (typeof error.data !== 'object' || error.data === null || !('code' in error.data)) {
    return null
  }
  const code = error.data.code
  return typeof code === 'string' ? code : null
}

export function readableError(error: unknown) {
  if (error instanceof ConvexError) {
    if (typeof error.data === 'string' && error.data.trim()) return error.data
    if (typeof error.data === 'object' && error.data !== null && 'message' in error.data) {
      const message = error.data.message
      if (typeof message === 'string' && message.trim()) return message
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message
  return fallbackMessage
}
