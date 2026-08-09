import { ConvexError } from 'convex/values'

/**
 * What a person is allowed to be shown when something fails.
 *
 * The server raises a ConvexError when it has deliberately refused something,
 * and that text is written for a human: "This team is already at a table",
 * "The round is closed". Everything else is a crash, a dropped connection or a
 * native module complaining, and its message is a stack trace in disguise.
 *
 * Previously every panel returned `caught.message` for anything, so a volunteer
 * at a door was shown "FunctionCallException: Calling the 'prepareAsync'
 * function has failed (at ExpoModulesCore/AsyncFunctionDefinition.swift:123)".
 * Nobody standing at a door can act on that, and it makes a recoverable
 * hiccup look like the app is broken.
 */
export function describeError(caught: unknown, fallback: string) {
  if (caught instanceof ConvexError) {
    const data: unknown = caught.data
    if (typeof data === 'string' && data.trim()) return data
    if (data !== null && typeof data === 'object' && 'message' in data) {
      const message: unknown = (data as { message: unknown }).message
      if (typeof message === 'string' && message.trim()) return message
    }
  }
  return fallback
}
