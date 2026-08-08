export function readableError(error: unknown) {
  if (typeof error === 'object' && error !== null) {
    if ('data' in error) {
      const data = error.data
      if (typeof data === 'object' && data !== null && 'message' in data) {
        const message = data.message
        if (typeof message === 'string') return message
      }
    }
    if ('message' in error && typeof error.message === 'string') {
      return error.message
    }
  }
  return 'Something went wrong. Try again.'
}

export function operationId(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`
}
