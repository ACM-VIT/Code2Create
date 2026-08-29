import { useEffect, useState } from 'react'
import { ScreenFixture } from './screenFixtures'
import { GALLERY_SCREENS } from './screenList'

// Development-only screen switcher. Mounted from App behind `import.meta.env.DEV`
// via a dynamic import, so neither this nor its fixtures reach a production
// bundle. Lets the portal's screens be reviewed without walking the whole flow.

const STORAGE_KEY = 'code2create.dev.screen'
const WIDTHS = [
  { id: 'full', label: 'full' },
  { id: 'desktop', label: '1280', width: 1280 },
  { id: 'mobile', label: '390', width: 390 },
] as const

type WidthId = (typeof WIDTHS)[number]['id']

export function ScreenGallery() {
  const [open, setOpen] = useState(false)
  const [screenId, setScreenId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  })
  const [widthId, setWidthId] = useState<WidthId>('full')

  useEffect(() => {
    try {
      if (screenId) localStorage.setItem(STORAGE_KEY, screenId)
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      // A private window without storage still works; the choice just won't stick.
    }
  }, [screenId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setScreenId(null)
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const active = GALLERY_SCREENS.find((screen) => screen.id === screenId) ?? null
  const width = WIDTHS.find((option) => option.id === widthId)

  return (
    <>
      {active ? (
        <div className="fixed inset-0 z-[9998] overflow-auto bg-ink">
          <div
            className="mx-auto min-h-full"
            style={width && 'width' in width ? { maxWidth: `${width.width}px` } : undefined}
          >
            <ScreenFixture id={active.id} />
          </div>
        </div>
      ) : null}

      <div data-dev-gallery className="fixed bottom-3 left-3 z-[9999] font-mono text-[11px]">
        {open ? (
          <div className="mb-2 w-52 overflow-hidden rounded-lg border border-[rgb(216_132_162/.4)] bg-[rgb(12_0_4/.94)] shadow-[0_18px_40px_-12px_rgba(0,0,0,.9)] backdrop-blur-md">
            <div className="flex items-center gap-1 border-b border-[rgb(216_132_162/.25)] px-2 py-1.5">
              {WIDTHS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setWidthId(option.id)}
                  className={`rounded px-1.5 py-0.5 ${
                    widthId === option.id
                      ? 'bg-rose-light text-ink'
                      : 'text-[rgb(248_248_248/.55)] hover:text-paper'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="max-h-[60vh] overflow-auto py-1">
              <button
                type="button"
                onClick={() => setScreenId(null)}
                className={`block w-full px-3 py-1.5 text-left ${
                  active === null ? 'text-rose-light' : 'text-[rgb(248_248_248/.6)] hover:text-paper'
                }`}
              >
                live app
              </button>
              {GALLERY_SCREENS.map((screen) => (
                <button
                  key={screen.id}
                  type="button"
                  onClick={() => setScreenId(screen.id)}
                  className={`block w-full px-3 py-1.5 text-left ${
                    screenId === screen.id
                      ? 'text-rose-light'
                      : 'text-[rgb(248_248_248/.6)] hover:text-paper'
                  }`}
                >
                  <span className="inline-block w-12 text-[rgb(248_248_248/.35)]">{screen.id}</span>
                  {screen.label}
                </button>
              ))}
            </div>
            <p className="border-t border-[rgb(216_132_162/.25)] px-3 py-1.5 text-[10px] text-[rgb(248_248_248/.35)]">
              fixture content · esc exits
            </p>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-lg border border-[rgb(216_132_162/.4)] bg-[rgb(12_0_4/.9)] px-2.5 py-1.5 text-[rgb(248_248_248/.7)] shadow-lg backdrop-blur-md hover:text-paper"
        >
          ◧ {active ? active.id : 'screens'}
        </button>
      </div>
    </>
  )
}
