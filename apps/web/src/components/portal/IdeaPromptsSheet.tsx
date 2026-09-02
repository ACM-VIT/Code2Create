import { useState } from 'react'
import { Drawer } from 'vaul'
import { ideaPromptSections } from '../../lib/ideaPrompts'
import { useDesktop } from '../../lib/useDesktop'

/**
 * The quiet line under the idea box for teams who arrive empty-handed. It
 * opens the organisers' list of directions — a side sheet on wide screens,
 * a bottom sheet on phones — grouped as they wrote them.
 */
export function IdeaPromptsLink({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false)
  const desktop = useDesktop()

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`text-[12.5px] text-rose-light transition-colors hover:text-fg ${className}`}
      >
        Can’t come up with an idea?
      </button>

      <Drawer.Root open={open} onOpenChange={setOpen} direction={desktop ? 'right' : 'bottom'}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-[rgb(6_0_2/.5)]" />
          <Drawer.Content
            className={
              desktop
                ? 'fixed inset-y-0 right-0 z-50 flex w-[460px] max-w-[92vw] flex-col border-l border-petal-edge bg-wash font-ui text-fg outline-none'
                : 'fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-tl-box border-t border-petal-edge bg-wash font-ui text-fg outline-none'
            }
          >
            {desktop ? null : (
              <div aria-hidden className="mx-auto mt-3 h-1 w-10 flex-none rounded-full bg-rose/40" />
            )}

            <div className="flex flex-none items-start justify-between gap-4 px-7 pt-6 pb-3">
              <div>
                <Drawer.Title className="m-0 font-display font-light tracking-[-.01em] text-[26px] text-fg">
                  Here’s some ideas
                </Drawer.Title>
              </div>
              <Drawer.Close
                aria-label="Close"
                className="flex size-9 flex-none cursor-pointer appearance-none items-center justify-center rounded-full border border-rose/50 bg-transparent p-0 text-fg/60 transition-colors hover:border-rose-light hover:text-rose-light"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </Drawer.Close>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-[calc(28px+env(safe-area-inset-bottom))]">
              {ideaPromptSections.map((section) => (
                <section key={section.title} className="mt-6 first:mt-2">
                  <h3 className="m-0 mb-1 text-[11px] font-semibold tracking-[.08em] text-rose-light/85">
                    {section.title}
                  </h3>
                  <ul className="m-0 list-none divide-y divide-petal-line p-0">
                    {section.prompts.map((prompt) => (
                      <li key={prompt.title} className="py-3">
                        <p className="m-0 text-[14px] leading-snug text-fg/90">{prompt.title}</p>
                        {prompt.detail ? (
                          <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-fg/55">
                            {prompt.detail}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </>
  )
}
