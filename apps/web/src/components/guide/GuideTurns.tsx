import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { LoadingLine } from "./GuideLoader";
import { GuideMarkdown, type OfficialLink } from "./GuideMarkdown";

const turnIn = "motion-safe:animate-turn-in";

/** What the participant asked: a filled note on the right. */
export function UserTurn({ text }: { text: string }) {
  return (
    <div className={`flex justify-end ${turnIn}`}>
      <p className="m-0 max-w-[82%] whitespace-pre-wrap rounded-[18px_18px_6px_18px] bg-fg/[0.07] px-4 py-2.5 text-[14px] leading-relaxed text-fg sm:max-w-[72%]">
        {text}
      </p>
    </div>
  );
}

export function GuideTurn({
  text,
  streaming,
  officialLinks,
  thinking,
  actions,
}: {
  text: string;
  streaming: boolean;
  officialLinks: readonly OfficialLink[];
  thinking?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <article className={`min-w-0 ${turnIn}`}>
      {thinking}
      <div className={streaming ? "guide-streaming" : undefined}>
        <GuideMarkdown text={text} officialLinks={officialLinks} />
      </div>
      {actions ? <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div> : null}
    </article>
  );
}

/** A reply from a person on the event team: a rose note on the left. */
export function TeamTurn({ body }: { body: string }) {
  return (
    <div className={`flex justify-start ${turnIn}`}>
      <p className="m-0 max-w-[88%] whitespace-pre-wrap rounded-[6px_18px_18px_18px] bg-rose-deep/20 px-4 py-3 text-[14px] leading-relaxed text-fg sm:max-w-[78%]">
        {body}
      </p>
    </div>
  );
}

/** A moment in the thread that is not a message: someone joined, a state changed. */
export function SystemLine({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-fg/45">
      <span aria-hidden className="h-px flex-1 bg-petal-line/70" />
      <span className="flex-none">{children}</span>
      <span aria-hidden className="h-px flex-1 bg-petal-line/70" />
    </div>
  );
}

/** The Guide at work before anything has arrived. */
export function ThinkingTurn({
  label = "Looking through your event details",
  startedAt,
}: {
  label?: string;
  startedAt?: number | undefined;
}) {
  return (
    <div className={`flex min-h-9 items-center ${turnIn}`}>
      <LoadingLine label={label} startedAt={startedAt} />
    </div>
  );
}

/** Something went wrong with an answer: the message, and what can be done next. */
export function GuideNotice({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div role="alert" className={`rounded-petal-sm bg-rose-deep/15 px-4 py-3 ${turnIn}`}>
      <p className="m-0 text-[13px] leading-relaxed text-fg/80">{message}</p>
      {children ? <div className="mt-2.5 flex flex-wrap gap-2">{children}</div> : null}
    </div>
  );
}

const chip =
  "rounded-full px-3.5 py-1.5 text-left text-[12px] leading-snug transition-colors disabled:cursor-not-allowed disabled:opacity-45";

/** A follow-up or action in chip form: a quiet fill by default, rose when it matters. */
export function GuideChip({
  children,
  onClick,
  disabled = false,
  accent = false,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`${chip} ${
        accent
          ? "bg-rose/15 text-rose-light hover:bg-rose/25"
          : "bg-fg/[0.06] text-fg/75 hover:bg-fg/10 hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}

/** A link the event published, offered under an answer the way sources ride under streamed text. */
export function LinkChip({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`${chip} inline-flex items-center gap-1.5 bg-fg/[0.06] text-fg/75 no-underline hover:bg-fg/10 hover:text-fg`}
    >
      {children}
      <svg viewBox="0 0 24 24" className="size-3 fill-none stroke-current stroke-[2]" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 17 17 7m0 0H9m8 0v8" />
      </svg>
    </a>
  );
}

/** The empty thread: the Guide introduces itself and offers three ways in. */
export function GuideHero({
  description,
  suggestions,
  onPick,
  disabled = false,
}: {
  description: string;
  suggestions: readonly string[];
  onPick: (suggestion: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex w-full flex-col items-center text-center">
      <h1 className="m-0 mb-3 font-display font-light tracking-[-.01em] text-balance text-[32px] leading-[1.1] lg:text-[40px]">
        Ask the Guide.
      </h1>
      <p className="m-0 mb-7 max-w-[520px] text-balance text-[14px] leading-relaxed text-fg/60">
        {description}
      </p>
      <div className="flex max-w-[560px] flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            disabled={disabled}
            onClick={() => onPick(suggestion)}
            className="rounded-full bg-fg/[0.06] px-4 py-2.5 text-[13px] leading-snug text-fg/80 transition-colors hover:bg-fg/10 hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The panel's top bar: a way back, the Guide's name, and one quiet line for
 * what it knows right now — the phase, the date that matters, and who else
 * is in the room.
 */
export function GuideHeader({
  phaseLabel,
  deadline,
  team,
}: {
  phaseLabel: string;
  deadline?: string | undefined;
  team?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Link
        to="/"
        viewTransition
        aria-label="Back home"
        title="Back home"
        className="-ml-1.5 inline-grid size-9 flex-none place-items-center rounded-full text-fg/60 no-underline transition-colors hover:bg-fg/5 hover:text-rose-light"
      >
        <svg viewBox="0 0 24 24" className="size-4 fill-none stroke-current stroke-[2]" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="m15 6-6 6 6 6" />
        </svg>
      </Link>
      <div className="min-w-0">
        <p className="m-0 font-display font-light tracking-[-.01em] text-[20px] leading-none text-fg">
          Guide
        </p>
        <p className="m-0 mt-1 truncate text-[11.5px] text-fg/50">
          {phaseLabel.toLowerCase()}
          {deadline ? ` · ${deadline}` : ""}
          {team ? <span className="text-rose-light"> · {team}</span> : null}
        </p>
      </div>
    </div>
  );
}
