import type { ButtonHTMLAttributes, ReactNode } from "react";

import { PortalButton } from "../portal/PortalButton";
import { PortalField, PortalInput } from "../portal/PortalField";
import { PetalCard } from "../portal/PetalCard";

/**
 * The connected-tools page is a sheet per tool and plain rows for what the
 * team has connected. Everything here is presentation; the screens keep the
 * logic.
 */

/** One tool's sheet: mark, name, one quiet line, the action beside them. */
export function ToolSheet({
  mark,
  name,
  meta,
  action,
  children,
}: {
  mark: ReactNode;
  name: string;
  meta: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PetalCard className="flex flex-col gap-5 px-5 py-5 sm:px-7 sm:py-6">
      <header className="flex items-center gap-3.5">
        <span className="flex size-9 shrink-0 items-center justify-center text-fg">{mark}</span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 font-display text-[19px] font-normal leading-none text-fg">{name}</h2>
          <p className="m-0 mt-1 truncate text-[12px] text-fg/55">{meta}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      {children}
    </PetalCard>
  );
}

/** A small heading row for a group inside a sheet, with an optional count. */
export function SectionLabel({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <h3 className="m-0 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">{children}</h3>
      {aside ? <span className="text-[11px] tabular-nums text-fg/50">{aside}</span> : null}
    </div>
  );
}

/** A line to read before acting. */
export function ToolNotice({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[12.5px] leading-relaxed text-fg/60">{children}</p>;
}

/** Fine print under a row: a caveat, a next retry, how to fix a topic. */
export function RowNote({
  tone = "quiet",
  children,
}: {
  tone?: "quiet" | "warn";
  children: ReactNode;
}) {
  return (
    <p
      className={`m-0 text-[11px] leading-relaxed ${
        tone === "warn" ? "text-rose-light/90" : "text-fg/50"
      }`}
    >
      {children}
    </p>
  );
}

/** The quiet actions under a row: move, refresh, archive. */
export function RowAction({
  tone = "quiet",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "quiet" | "danger"; children: ReactNode }) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-sm text-[11.5px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === "danger" ? "text-fg/40 hover:text-rose-light" : "text-fg/55 hover:text-rose-light"
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** One connected repository or file: a title, one line, its state. */
export function ItemRow({
  title,
  href,
  meta,
  status,
  statusTone = "quiet",
  notes,
  actions,
  children,
}: {
  title: string;
  href: string;
  meta: ReactNode;
  status: ReactNode;
  statusTone?: "quiet" | "warn";
  notes?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2 py-3.5">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-[14px] text-fg underline-offset-4 hover:text-rose-light hover:underline"
          >
            {title}
          </a>
          <p className="m-0 mt-0.5 truncate text-[11.5px] text-fg/50">{meta}</p>
        </div>
        <span
          className={`shrink-0 whitespace-nowrap text-[11px] ${
            statusTone === "warn" ? "text-rose-light" : "text-fg/50"
          }`}
        >
          {status}
        </span>
      </div>
      {notes}
      {actions ? <div className="flex flex-wrap items-center gap-x-4 gap-y-1">{actions}</div> : null}
      {children}
    </li>
  );
}

/** A list of ItemRows, ruled by hairlines. */
export function ItemList({ children }: { children: ReactNode }) {
  return <ul className="m-0 flex list-none flex-col divide-y divide-petal-line p-0">{children}</ul>;
}

/** The picker: one repository the team may add. */
export function OptionRow({
  title,
  detail,
  disabled,
  onSelect,
}: {
  title: string;
  detail: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        className="flex w-full items-baseline justify-between gap-4 py-2.5 text-left transition-colors hover:text-rose-light disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:text-fg"
      >
        <span className="truncate text-[13px] text-fg/90">{title}</span>
        <span className="shrink-0 text-[11px] text-fg/50">{detail}</span>
      </button>
    </li>
  );
}

/** "Why are you removing it?" — the reason field and the two buttons, inline. */
export function ArchivePrompt({
  reason,
  onReason,
  onCancel,
  onConfirm,
  busy,
  disabled = false,
  confirmDisabled = false,
  confirmLabel = "Archive",
  question = "Why are you removing it?",
}: {
  reason: string;
  onReason: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  /** Freezes the whole prompt (another change is in flight). */
  disabled?: boolean;
  /** Holds only the confirm (no reason typed yet). */
  confirmDisabled?: boolean;
  confirmLabel?: string;
  question?: string;
}) {
  return (
    <div className="mt-1 flex flex-col gap-3">
      <PortalField label={question}>
        {(id) => (
          <PortalInput
            id={id}
            value={reason}
            maxLength={180}
            disabled={busy || disabled}
            onChange={(event) => onReason(event.target.value)}
          />
        )}
      </PortalField>
      <div className="flex justify-end gap-2">
        <PortalButton size="xs" disabled={busy || disabled} onClick={onCancel}>
          Cancel
        </PortalButton>
        <PortalButton
          size="xs"
          variant="solid"
          disabled={busy || disabled || confirmDisabled}
          onClick={onConfirm}
        >
          {busy ? "Working…" : confirmLabel}
        </PortalButton>
      </div>
    </div>
  );
}

/** A reply went missing; the participant confirms the earlier change once. */
export function PendingBar({
  message,
  action,
  busy,
  onConfirm,
}: {
  message: ReactNode;
  action: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <p className="m-0 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[12.5px] text-fg/70">
      <span>{message}</span>
      <button
        type="button"
        disabled={busy}
        onClick={onConfirm}
        className="text-[12.5px] text-rose-light underline-offset-4 hover:underline disabled:opacity-50"
      >
        {busy ? "Confirming…" : action}
      </button>
    </p>
  );
}
