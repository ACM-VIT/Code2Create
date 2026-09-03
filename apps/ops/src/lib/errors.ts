import { ConvexError } from "convex/values";

const fallbackMessage = "Something went wrong. Try again.";

export function convexErrorCode(error: unknown) {
  if (!(error instanceof ConvexError)) return null;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("code" in data)) {
    return null;
  }
  const code = data.code;
  return typeof code === "string" ? code : null;
}

export function isConvexErrorCode(error: unknown, code: string) {
  return convexErrorCode(error) === code;
}

export function readableError(error: unknown) {
  if (error instanceof ConvexError) {
    const data: unknown = error.data;
    if (typeof data === "string" && data.trim()) return data;
    if (typeof data === "object" && data !== null && "message" in data) {
      const message = data.message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallbackMessage;
}
