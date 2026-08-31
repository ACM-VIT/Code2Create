import { useEffect, useState } from 'react'
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

export function ScreenGallery() {
  const [open, setOpen] = useState(false)
  const [screenId, setScreenId] = useState<string | null>(null)
  const [widthId, setWidthId] = useState<WidthId>('full')

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
        <div className="fixed inset-0 z-[9998] overflow-auto bg-wash">
          <div
            className="mx-auto min-h-full"
            style={width && 'width' in width ? { maxWidth: `${width.width}px` } : undefined}
          >
            <ScreenFixture id={active.id} />
          </div>
          <button
            type="button"
            onClick={() => setScreenId(null)}
            className="fixed top-3 left-1/2 z-[9999] -translate-x-1/2 rounded-full border border-rose/50 bg-wash/92 px-3.5 py-1.5 font-mono text-[11px] text-rose-light shadow-lg backdrop-blur-md hover:text-fg"
          >
            fixture {active.id} — not the live app · click or esc to exit
          </button>
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
            <div className="max-h-[60vh] overflow-auto py-1">
              <button
                type="button"
                onClick={() => setScreenId(null)}
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
                  onClick={() => setScreenId(screen.id)}
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
              fixture content · esc exits
            </p>
          </div>
        ) : null}

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded-lg border border-rose/40 bg-wash/90 px-2.5 py-1.5 text-fg/70 shadow-lg backdrop-blur-md hover:text-fg"
        >
          ◧ {active ? active.id : 'screens'}
        </button>
      </div>
    </>
  )
}
