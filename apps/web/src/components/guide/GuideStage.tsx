import type { ReactNode } from 'react'
import { StickToBottom, useStickToBottomContext } from 'use-stick-to-bottom'

export function GuideStage({
  header,
  children,
  composer,
}: {
  header: ReactNode
  children: ReactNode
  composer: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 w-full max-w-[760px] flex-col overflow-hidden rounded-petal glass guide-panel">
      <div className="flex flex-none items-center justify-between gap-3 border-b border-petal-line/60 px-4 py-2.5 sm:px-5">
        {header}
      </div>
      <StickToBottom className="relative min-h-0 flex-1 overflow-y-hidden" resize="smooth" initial="instant">
        <StickToBottom.Content
          role="log"
          aria-live="polite"
          aria-label="Conversation with the Guide"
          scrollClassName="guide-scroll h-full overflow-y-auto overscroll-contain"
          className="flex min-h-full flex-col gap-6 px-4 pt-5 pb-6 sm:px-6"
        >
          {children}
        </StickToBottom.Content>
        <ScrollToNewest />
      </StickToBottom>
      <div className="flex-none border-t border-petal-line/60 px-3 py-2.5 sm:px-4">{composer}</div>
    </div>
  )
}

function ScrollToNewest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext()
  if (isAtBottom) return null
  return (
    <button
      type="button"
      aria-label="Scroll to the newest message"
      onClick={() => void scrollToBottom()}
      className="absolute bottom-3 left-1/2 inline-grid size-9 -translate-x-1/2 place-items-center rounded-full glass-menu text-fg/80 transition-colors hover:text-rose-light motion-safe:animate-turn-in"
    >
      <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[2]" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 5v14m0 0 6-6m-6 6-6-6" />
      </svg>
    </button>
  )
}
