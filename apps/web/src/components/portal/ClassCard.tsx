export function ClassCard({
  title,
  detail,
  selected,
  disabled,
  onSelect,
}: {
  title: string
  detail: string
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
      className={`w-full rounded-petal-sm px-6 py-5 text-left transition-all duration-250 disabled:cursor-not-allowed disabled:opacity-45 motion-safe:disabled:hover:animate-shake sm:w-[250px] ${
        selected
          ? 'glass-tile glass-active'
          : 'glass-tile'
      }`}
    >
      <p
        className={`mb-1 font-display font-light tracking-[-.01em] text-[19px] ${
          selected ? 'text-rose-light' : 'text-fg/85'
        }`}
      >
        {title}
      </p>
      <p className="text-xs text-fg/55">{detail}</p>
    </button>
  )
}
