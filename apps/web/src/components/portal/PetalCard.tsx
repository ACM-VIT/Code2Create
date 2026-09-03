import type { ReactNode } from "react";

export function PetalCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className="relative w-full">
      <div className={`relative rounded-petal glass ${className}`}>{children}</div>
    </div>
  );
}
export function PetalDivider({ className = "" }: { className?: string }) {
  return <div aria-hidden className={`border-t border-petal-line ${className}`} />;
}
