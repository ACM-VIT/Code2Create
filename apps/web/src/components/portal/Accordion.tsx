import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type AccordionVariant = 'default' | 'outlined' | 'splitted'

const wrapperVariants: Record<AccordionVariant, string> = {
  default: '',
  outlined: 'overflow-clip rounded-petal-sm',
  splitted: 'gap-y-2',
}

const itemVariants: Record<AccordionVariant, string> = {
  default: 'border-b border-petal-line last:border-b-0',
  outlined: 'border-x border-t border-petal-edge-soft last:border-b',
  splitted: 'rounded-petal-sm border border-petal-edge-soft',
}

type AccordionContextValue = {
  variant: AccordionVariant
  openValues: readonly string[]
  toggle: (value: string) => void
  disabled: boolean
}

const AccordionContext = createContext<AccordionContextValue | null>(null)

function useAccordionContext(component: string) {
  const context = useContext(AccordionContext)
  if (!context) throw new Error(`${component} must be used within AccordionRoot`)
  return context
}

type AccordionItemContextValue = {
  open: boolean
  disabled: boolean
  panelId: string
  triggerId: string
  toggle: () => void
}

const AccordionItemContext = createContext<AccordionItemContextValue | null>(null)

function useAccordionItemContext(component: string) {
  const context = useContext(AccordionItemContext)
  if (!context) throw new Error(`${component} must be used within AccordionItem`)
  return context
}

export function AccordionRoot({
  children,
  allowMultiple = false,
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  variant = 'default',
  className = '',
}: {
  children: ReactNode
  /** Allows several panels to stay open at once. @default false */
  allowMultiple?: boolean
  /** Controlled values of the currently open items. */
  value?: readonly string[]
  /** Values of the initially open items for uncontrolled usage. */
  defaultValue?: readonly string[]
  /** Called with the next set of open values. */
  onValueChange?: (value: readonly string[]) => void
  /** Whether the whole accordion ignores interaction. @default false */
  disabled?: boolean
  /** Visual style of the accordion. @default "default" */
  variant?: AccordionVariant
  className?: string
}) {
  const [uncontrolled, setUncontrolled] = useState<readonly string[]>(defaultValue ?? [])
  const openValues = value ?? uncontrolled

  const toggle = (itemValue: string) => {
    const next = openValues.includes(itemValue)
      ? openValues.filter((open) => open !== itemValue)
      : allowMultiple
        ? [...openValues, itemValue]
        : [itemValue]
    if (value === undefined) setUncontrolled(next)
    onValueChange?.(next)
  }

  return (
    <AccordionContext.Provider value={{ variant, openValues, toggle, disabled }}>
      <div className={`flex w-full flex-col items-stretch ${wrapperVariants[variant]} ${className}`}>
        {children}
      </div>
    </AccordionContext.Provider>
  )
}

export function AccordionItem({
  children,
  value,
  disabled = false,
  className = '',
}: {
  children: ReactNode
  /** Stable value identifying the item; generated when omitted. */
  value?: string
  disabled?: boolean
  className?: string
}) {
  const generatedValue = useId()
  const itemValue = value ?? generatedValue
  const accordion = useAccordionContext('AccordionItem')
  const panelId = useId()
  const triggerId = useId()
  const open = accordion.openValues.includes(itemValue)
  const itemDisabled = disabled || accordion.disabled

  return (
    <AccordionItemContext.Provider
      value={{
        open,
        disabled: itemDisabled,
        panelId,
        triggerId,
        toggle: () => accordion.toggle(itemValue),
      }}
    >
      <div
        data-open={open ? '' : undefined}
        className={`relative w-full min-w-0 ${itemVariants[accordion.variant]} ${className}`}
      >
        {children}
      </div>
    </AccordionItemContext.Provider>
  )
}

/** The clickable row. Wrap an AccordionItemHeader to get the open-state mark. */
export function AccordionItemTrigger({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  const { open, disabled, panelId, triggerId, toggle } = useAccordionItemContext(
    'AccordionItemTrigger',
  )
  return (
    <h3 className="m-0 w-full">
      <button
        type="button"
        id={triggerId}
        aria-expanded={open}
        aria-controls={panelId}
        disabled={disabled}
        onClick={toggle}
        data-panel-open={open ? '' : undefined}
        className={`group block w-full min-w-0 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-light/60 disabled:cursor-not-allowed motion-safe:disabled:hover:animate-shake disabled:opacity-50 ${className}`}
      >
        {children}
      </button>
    </h3>
  )
}

export function AccordionItemHeader({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  useAccordionItemContext('AccordionItemHeader')
  return (
    <div className={`flex w-full min-w-0 items-center justify-between gap-4 py-4 ${className}`}>
      <div className="min-w-0 flex-1">{children}</div>
      <AnimatedPlusMinusMark />
    </div>
  )
}

/** A plus that becomes a minus: the bar fades, the stem turns. */
export function AnimatedPlusMinusMark({ size = 18 }: { size?: number }) {
  const { open } = useAccordionItemContext('AnimatedPlusMinusMark')
  return (
    <span aria-hidden className="flex flex-none items-center justify-center text-rose-light">
      <svg width={size} height={size} viewBox="0 0 24 24">
        <line
          x1="1"
          y1="12"
          x2="23"
          y2="12"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          className={`origin-center transition-opacity duration-200 motion-reduce:transition-none ${
            open ? 'opacity-0' : 'opacity-100'
          }`}
        />
        <line
          x1="12"
          y1="1"
          x2="12"
          y2="23"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          className={`origin-center transition-transform duration-200 motion-reduce:transition-none ${
            open ? 'rotate-90' : 'rotate-0'
          }`}
        />
      </svg>
    </span>
  )
}

/**
 * The panel. Height is measured from the content — and re-measured while it
 * changes, so a textarea growing inside an open panel keeps the frame honest.
 */
export function AccordionItemContent({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  const { open, panelId, triggerId } = useAccordionItemContext('AccordionItemContent')
  const inner = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  // The first paint lands in its resting state; only later changes animate.
  const [settled, setSettled] = useState(false)

  useEffect(() => {
    const element = inner.current
    if (!element) return
    const measure = () => setHeight(element.getBoundingClientRect().height)
    measure()
    setSettled(true)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      id={panelId}
      role="region"
      aria-labelledby={triggerId}
      data-open={open ? '' : undefined}
      style={{ height: open ? height : 0 }}
      className={`w-full min-w-0 overflow-hidden ${
        settled
          ? 'transition-[height,opacity] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none'
          : ''
      } ${open ? 'opacity-100' : 'opacity-0'}`}
    >
      <div ref={inner} inert={!open} className={`w-full min-w-0 pb-4 ${className}`}>
        {children}
      </div>
    </div>
  )
}
