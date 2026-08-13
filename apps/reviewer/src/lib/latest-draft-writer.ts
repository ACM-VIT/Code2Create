export function createLatestDraftWriter<Draft>(write: (draft: Draft) => Promise<void>) {
  let latest: Draft | null = null
  return {
    update(draft: Draft | null) {
      latest = draft
    },
    flush() {
      return latest === null ? Promise.resolve() : write(latest)
    },
  }
}
