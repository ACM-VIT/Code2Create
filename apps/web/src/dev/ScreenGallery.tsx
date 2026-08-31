import { flushSync } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { DelayedBonsai } from '../components/portal/DelayedBonsai'
import { ScreenFixture } from './screenFixtures'
import { GALLERY_SCREENS } from './screenList'

// Development-only screen switcher. Mounted from App behind `import.meta.env.DEV`
// via a dynamic import, so neither this nor its fixtures reach a production
// bundle. Lets the portal's screens be reviewed without walking the whole flow.
// Deliberately not persisted: a remembered fixture would silently shadow the
// live app after a reload and swallow every click.
const WIDTHS = [
  { id: 'full', label: 'full' },
  { id: 'desktop', label: '1280', width: 1280 },
  { id: 'mobile', label: '390', width: 390 },
] as const

type WidthId = (typeof WIDTHS)[number]['id']
type Delay = 0 | 1200

export function ScreenGallery() {
  const [open, setOpen] = useState(false)
  const [screenId, setScreenId] = useState<string | null>(null)
  const [pendingScreenId, setPendingScreenId] = useState<string | null>(null)
  const [delay, setDelay] = useState<Delay>(0)
  const [widthId, setWidthId] = useState<WidthId>('full')
  const pendingTimer = useRef<number | null>(null)

  const cancelPending = () => {
    if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current)
    pendingTimer.current = null
    setPendingScreenId(null)
  }

  const showScreen = (nextScreenId: string | null) => {
    cancelPending()
    const commit = () => {
      const update = () => flushSync(() => setScreenId(nextScreenId))
      if (document.startViewTransition) {
        document.startViewTransition(update)
      } else {
        update()
      }
      setPendingScreenId(null)
      pendingTimer.current = null
    }

    if (delay === 0 || nextScreenId === null || screenId === null) {
      commit()
      return
    }

    setPendingScreenId(nextScreenId)
    pendingTimer.current = window.setTimeout(commit, delay)
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        cancelPending()
        setScreenId(null)
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (pendingTimer.current !== null) window.clearTimeout(pendingTimer.current)
    }
  }, [])

  const active = GALLERY_SCREENS.find((screen) => screen.id === screenId) ?? null
  const width = WIDTHS.find((option) => option.id === widthId)
  const activeIndex = active ? GALLERY_SCREENS.indexOf(active) : -1
  const previous = activeIndex > 0 ? GALLERY_SCREENS[activeIndex - 1] : null
  const next = activeIndex >= 0 && activeIndex < GALLERY_SCREENS.length - 1
    ? GALLERY_SCREENS[activeIndex + 1]
    : null

  return (
    <>
      {active ? (
        <div className="fixed inset-0 z-[9998] overflow-auto bg-wash">
          <div
            className="mx-auto min-h-full"
            style={width && 'width' in width ? { maxWidth: `${width.width}px` } : undefined}
          >
            <ScreenFixture id={active.id} />
          </div>
          {pendingScreenId ? (
            <div className="fixed inset-0 z-[9998] grid place-items-center bg-wash/8 backdrop-blur-[1px]">
              <DelayedBonsai />
            </div>
          ) : null}
          <div className="fixed top-3 left-1/2 z-[9999] flex -translate-x-1/2 items-center overflow-hidden rounded-full border border-rose/50 bg-wash/92 font-mono text-[11px] text-rose-light shadow-lg backdrop-blur-md">
            <button type="button" disabled={!previous || pendingScreenId !== null} onClick={() => previous && showScreen(previous.id)} className="px-3 py-1.5 hover:text-fg disabled:opacity-25">←</button>
            <span className="border-x border-rose/25 px-3.5 py-1.5">
              {pendingScreenId ? `${active.id} · holding for ${delay}ms` : `mock route · ${active.id}`}
            </span>
            <button type="button" disabled={!next || pendingScreenId !== null} onClick={() => next && showScreen(next.id)} className="px-3 py-1.5 hover:text-fg disabled:opacity-25">→</button>
            <button type="button" onClick={() => showScreen(null)} className="border-l border-rose/25 px-3 py-1.5 hover:text-fg">×</button>
          </div>
        </div>
      ) : null}

      <div data-dev-gallery className="fixed bottom-3 left-3 z-[9999] font-mono text-[11px]">
        {open ? (
          <div className="mb-2 w-52 overflow-hidden rounded-lg border border-rose/40 bg-wash/94 shadow-[0_18px_40px_-12px_var(--shade-2)] backdrop-blur-md">
            <div className="flex items-center gap-1 border-b border-rose/25 px-2 py-1.5">
              {WIDTHS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setWidthId(option.id)}
                  className={`rounded px-1.5 py-0.5 ${
                    widthId === option.id
                      ? 'bg-rose-light text-wash'
                      : 'text-fg/55 hover:text-fg'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 border-b border-rose/25 px-2 py-1.5">
              <span className="mr-auto text-[10px] text-fg/35">route delay</span>
              {([0, 1200] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setDelay(option)}
                  className={`rounded px-1.5 py-0.5 ${delay === option ? 'bg-rose-light text-wash' : 'text-fg/55 hover:text-fg'}`}
                >
                  {option === 0 ? 'off' : '1.2s'}
                </button>
              ))}
            </div>
            <div className="max-h-[60vh] overflow-auto py-1">
              <button
                type="button"
                onClick={() => showScreen(null)}
                className={`block w-full px-3 py-1.5 text-left ${
                  active === null ? 'text-rose-light' : 'text-fg/60 hover:text-fg'
                }`}
              >
                live app
              </button>
              {GALLERY_SCREENS.map((screen) => (
                <button
                  key={screen.id}
                  type="button"
                  disabled={pendingScreenId !== null}
                  onClick={() => showScreen(screen.id)}
                  className={`block w-full px-3 py-1.5 text-left ${
                    screenId === screen.id
                      ? 'text-rose-light'
                      : 'text-fg/60 hover:text-fg'
                  }`}
                >
                  <span className="inline-block w-12 text-fg/35">{screen.id}</span>
                  {screen.label}
                </button>
              ))}
            </div>
            <p className="border-t border-rose/25 px-3 py-1.5 text-[10px] text-fg/35">
              mock routes · transitions work offline
            </p>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-lg border border-rose/40 bg-wash/90 px-2.5 py-1.5 text-fg/70 shadow-lg backdrop-blur-md hover:text-fg"
        >
          ◧ {pendingScreenId ? `${active?.id ?? 'mock'} → ${pendingScreenId}` : active ? active.id : 'screens'}
        </button>
      </div>
    </>
  )
}
