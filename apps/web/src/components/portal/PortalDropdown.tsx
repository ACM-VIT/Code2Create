import {
  FloatingFocusManager,
  FloatingList,
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useListItem,
  useListNavigation,
  useRole,
  useTransitionStyles,
  useTypeahead,
} from '@floating-ui/react'
import {
  Children,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

type DropdownContextValue = {
  activeIndex: number | null
  selectedIndex: number | null
  getItemProps: (props?: Record<string, unknown>) => Record<string, unknown>
  onSelect: (index: number) => void
}

const DropdownContext = createContext<DropdownContextValue | null>(null)

function useDropdownContext() {
  const context = useContext(DropdownContext)
  if (!context) throw new Error('Dropdown items must render inside <PortalSelect>.')
  return context
}

export type DropdownOption = {
  value: string
  label: string
  disabled?: boolean
}

function readOptions(children: ReactNode): {
  options: DropdownOption[]
  placeholder: string | null
} {
  const options: DropdownOption[] = []
  let placeholder: string | null = null
  for (const child of Children.toArray(children)) {
    if (!isValidElement(child) || child.type !== 'option') continue
    const props = child.props as {
      value?: string | number
      disabled?: boolean
      children?: ReactNode
    }
    const value = String(props.value ?? '')
    const label = typeof props.children === 'string'
      ? props.children
      : Children.toArray(props.children).filter((part) => typeof part === 'string').join('')
    if (value === '') {
      placeholder = label
      continue
    }
    options.push({ value, label, ...(props.disabled ? { disabled: true } : {}) })
  }
  return { options, placeholder }
}

function DropdownIndicator({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`size-4 shrink-0 text-fg/45 transition-transform duration-200 ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none ${
        open ? 'rotate-180' : ''
      }`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

function DropdownItem({
  option,
  index,
  selected,
}: {
  option: DropdownOption
  index: number
  selected: boolean
}) {
  const { activeIndex, getItemProps, onSelect } = useDropdownContext()
  const { ref } = useListItem({ label: option.label })
  const active = activeIndex === index

  return (
    <li
      ref={ref}
      role="option"
      aria-selected={selected}
      aria-disabled={option.disabled ?? false}
      tabIndex={active ? 0 : -1}
      className={`relative flex cursor-pointer items-center justify-between gap-3 rounded-btn-sm px-3 py-2 text-[13.5px] outline-none select-none ${
        option.disabled ? 'cursor-not-allowed opacity-45' : ''
      } ${selected ? 'text-rose-light' : 'text-fg/85'}`}
      {...getItemProps({
        onClick: () => {
          if (option.disabled) return
          onSelect(index)
        },
      })}
    >
      <span className="relative z-[1] min-w-0 flex-1 truncate">{option.label}</span>
      {selected ? (
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="relative z-[1] size-3.5 flex-none text-rose-light"
        >
          <path d="m5 12.5 4.5 4.5L19 7" />
        </svg>
      ) : null}
    </li>
  )
}

export function PortalSelect({
  id,
  value,
  onValueChange,
  children,
  options: optionsProp,
  placeholder: placeholderProp,
  disabled = false,
  className = '',
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
}: {
  id?: string
  value: string
  onValueChange: (value: string) => void
  children?: ReactNode
  options?: readonly DropdownOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  'aria-label'?: string
  'aria-invalid'?: boolean
}) {
  const { options: childOptions, placeholder: childPlaceholder } = useMemo(
    () => readOptions(children),
    [children],
  )
  const options = useMemo(
    () => optionsProp ? [...optionsProp] : childOptions,
    [childOptions, optionsProp],
  )
  const placeholder = placeholderProp ?? childPlaceholder ?? 'Select'

  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState<number | null>(null)
  const elementsRef = useRef<Array<HTMLElement | null>>([])
  const labelsRef = useRef<Array<string | null>>([])
  const listRef = useRef<HTMLUListElement>(null)
  const [highlight, setHighlight] = useState<{ top: number; height: number } | null>(null)

  const selectedIndex = options.findIndex((option) => option.value === value)
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined

  const {
    refs: { setReference, setFloating },
    floatingStyles,
    context,
  } = useFloating({
    open,
    onOpenChange: setOpen,
    whileElementsMounted: autoUpdate,
    placement: 'bottom-start',
    middleware: [
      offset(6),
      flip({ padding: 12 }),
      shift({ padding: 12 }),
      size({
        padding: 12,
        apply({ rects, availableHeight, elements }) {
          elements.floating.style.width = `${rects.reference.width}px`
          elements.floating.style.maxHeight = `${Math.max(160, Math.min(availableHeight - 8, 288))}px`
        },
      }),
    ],
  })

  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: { open: 180, close: 130 },
    initial: ({ side }) => ({
      opacity: 0,
      transform: 'scale(.96)',
      transformOrigin: side === 'top' ? 'bottom center' : 'top center',
    }),
    open: { opacity: 1, transform: 'scale(1)' },
  })

  const click = useClick(context, { enabled: !disabled })
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: 'listbox' })
  const listNavigation = useListNavigation(context, {
    listRef: elementsRef,
    activeIndex,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
    disabledIndices: options.flatMap((option, index) => option.disabled ? [index] : []),
    onNavigate: setActiveIndex,
    loop: true,
  })
  const typeahead = useTypeahead(context, {
    listRef: labelsRef,
    activeIndex,
    selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
    onMatch: open ? setActiveIndex : undefined,
  })
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([
    click,
    dismiss,
    role,
    listNavigation,
    typeahead,
  ])

  const onSelect = useCallback(
    (index: number) => {
      const option = options[index]
      if (!option) return
      onValueChange(option.value)
      setOpen(false)
    },
    [onValueChange, options],
  )

  useLayoutEffect(() => {
    if (!isMounted) return
    const node = activeIndex === null ? null : elementsRef.current[activeIndex]
    const list = listRef.current
    if (!node || !list) {
      setHighlight(null)
      return
    }
    setHighlight({ top: node.offsetTop, height: node.offsetHeight })
  }, [activeIndex, isMounted])

  const context_ = useMemo<DropdownContextValue>(
    () => ({ activeIndex, selectedIndex, getItemProps, onSelect }),
    [activeIndex, selectedIndex, getItemProps, onSelect],
  )

  return (
    <>
      <button
        type="button"
        id={id}
        ref={setReference}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        className={`flex w-full items-center justify-between gap-2 rounded-petal-xs border border-petal-edge-soft bg-wash/45 px-3.5 py-2.5 text-left text-[13.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
          open ? 'border-rose-light' : ''
        } ${selectedOption ? 'text-fg' : 'text-fg/45'} ${className}`}
        {...getReferenceProps()}
      >
        <span className="min-w-0 flex-1 truncate">{selectedOption?.label ?? placeholder}</span>
        <DropdownIndicator open={open} />
      </button>

      {isMounted ? (
        <FloatingPortal>
          <FloatingFocusManager context={context} modal={false} initialFocus={-1}>
            <div
              ref={setFloating}
              style={{ ...floatingStyles, ...transitionStyles }}
              className="z-[60] overflow-y-auto rounded-petal-xs border border-petal-edge bg-[image:var(--roster-bg)] p-1 shadow-[0_24px_50px_-18px_var(--shade-2)] backdrop-blur-lg"
              {...getFloatingProps()}
            >
              <FloatingList elementsRef={elementsRef} labelsRef={labelsRef}>
                <ul ref={listRef} className="relative m-0 list-none p-0">
                  {highlight ? (
                    <li
                      aria-hidden
                      role="presentation"
                      className="pointer-events-none absolute inset-x-0 z-0 rounded-btn-sm bg-rose/18 transition-[transform,height] duration-200 ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none"
                      style={{
                        transform: `translateY(${highlight.top}px)`,
                        height: `${highlight.height}px`,
                      }}
                    />
                  ) : null}
                  <DropdownContext.Provider value={context_}>
                    {options.map((option, index) => (
                      <DropdownItem
                        key={option.value}
                        option={option}
                        index={index}
                        selected={option.value === value}
                      />
                    ))}
                  </DropdownContext.Provider>
                </ul>
              </FloatingList>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      ) : null}
    </>
  )
}
