import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { PortalButton, PortalTextButton } from "../portal/PortalButton";

export const messageMaximum = 1_600;
const composerMaximumHeight = 176;

export type ComposerConfirm = {
  question: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function GuideComposer({
  value,
  onChange,
  onSend,
  disabled,
  confirming = false,
  answering,
  leading,
  confirm,
  textareaRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  confirming?: boolean;
  answering: boolean;
  leading?: ReactNode;
  confirm?: ComposerConfirm;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const ready = (confirming || value.trim().length >= 2) && !disabled;

  if (confirm) {
    return (
      <div
        role="dialog"
        aria-label={confirm.question}
        className="flex min-h-[44px] flex-wrap items-center justify-between gap-x-4 gap-y-2 px-2 py-1 motion-safe:animate-turn-in"
      >
        <p className="m-0 min-w-0 flex-1 basis-[240px] text-[13.5px] leading-snug text-fg/85">
          {confirm.question}
        </p>
        <div className="flex flex-none items-center gap-3">
          <PortalTextButton type="button" disabled={confirm.busy} onClick={confirm.onCancel}>
            not now
          </PortalTextButton>
          <PortalButton
            type="button"
            size="xs"
            variant="solid"
            disabled={confirm.busy}
            onClick={confirm.onConfirm}
          >
            {confirm.busy ? "Asking…" : confirm.confirmLabel}
          </PortalButton>
        </div>
      </div>
    );
  }

  const fit = (element: HTMLTextAreaElement) => {
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, composerMaximumHeight)}px`;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    if (ready) onSend();
  };

  return (
    <div className="w-full">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onSend();
        }}
        className="flex items-end gap-1"
      >
        {leading}
        <textarea
          ref={textareaRef}
          rows={1}
          aria-label="Ask the Guide"
          maxLength={messageMaximum}
          disabled={disabled || confirming}
          value={value}
          placeholder={answering ? "The Guide is answering…" : "What do you need help with?"}
          className="guide-input max-h-[176px] min-h-[36px] flex-1 resize-none text-[14.5px] text-fg placeholder:text-fg/40 disabled:cursor-not-allowed disabled:opacity-50"
          onChange={(event) => {
            fit(event.currentTarget);
            onChange(event.currentTarget.value);
          }}
          onKeyDown={onKeyDown}
        />
        <button
          type="submit"
          aria-label={confirming ? "Confirm question" : "Send"}
          disabled={!ready}
          className="inline-grid size-9 flex-none place-items-center rounded-full bg-rose text-wash shadow-[0_10px_24px_-12px_var(--glow-rose)] transition-[filter,opacity,transform] duration-250 hover:brightness-105 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-4 fill-none stroke-current stroke-[2.2]"
            aria-hidden
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 19V5m0 0-6 6m6-6 6 6" />
          </svg>
        </button>
      </form>
      {value.length > 1_200 ? (
        <p className="m-0 mt-1 pr-2 text-right font-mono text-[11px] text-fg/45 tabular-nums">
          {value.length} / {messageMaximum}
        </p>
      ) : null}
    </div>
  );
}

/** The composer's leading control: opens the escalation card. Icon only; the name is in the tooltip. */
export function BringTeamTool({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label="Bring in the event team"
      title="Bring in the event team"
      className="inline-grid size-9 flex-none place-items-center rounded-full text-fg/50 transition-colors hover:bg-fg/5 hover:text-rose-light disabled:cursor-not-allowed disabled:opacity-40"
    >
      <svg
        viewBox="0 0 24 24"
        className="size-[18px] fill-none stroke-current stroke-[1.8]"
        aria-hidden
      >
        <circle cx="9" cy="8" r="3.2" />
        <circle cx="16.5" cy="9.5" r="2.4" />
        <path
          strokeLinecap="round"
          d="M3.5 18.5c.6-3 3-4.5 5.5-4.5s4.9 1.5 5.5 4.5M15 15c2.3 0 4.3 1.2 5 3.5"
        />
      </svg>
    </button>
  );
}
