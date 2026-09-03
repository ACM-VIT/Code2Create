import type { ComponentPropsWithoutRef, ReactNode } from "react";

export function StackedSheet({
  depth,
  label,
  children,
  ...buttonProps
}: Omit<ComponentPropsWithoutRef<"button">, "children" | "className" | "style"> & {
  depth: number;
  label: ReactNode;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      style={{ marginInline: Math.min(depth, 4) * 6 }}
      className="relative -mb-2.5 overflow-hidden rounded-tl-box-sm border-2 border-b-0 border-glass-edge bg-[image:var(--sheet-bg)] px-5 pt-1 pb-4 text-left shadow-[inset_0_1px_0_var(--card-topline)] backdrop-blur-md transition-transform duration-250 hover:-translate-y-1"
      {...buttonProps}
    >
      <span className="block truncate text-[12px] text-fg/75">{label}</span>
      {children}
    </button>
  );
}
