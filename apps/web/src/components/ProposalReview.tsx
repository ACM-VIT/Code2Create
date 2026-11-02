import { LiveNumber } from "./LiveNumber";
import { useState } from "react";
import {
  FloatingPortal,
  autoUpdate,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
} from "@floating-ui/react";
import { Drawer } from "vaul";
import { useDesktop } from "../lib/useDesktop";
import { type NoveltyBand, type NoveltyState, visibleNoveltySignal } from "../lib/noveltyPreview";

const noveltyBandLabels: Record<NoveltyBand, string> = {
  familiar: "similar",
  developing: "somewhat similar",
  distinct: "distinct",
};

/** The quiet "edit" at the foot of a review panel. */
export function ReviewEditRow({ onEdit, busy }: { onEdit: () => void; busy: boolean }) {
  return (
    <div className="mt-3 flex justify-end">
      <button
        type="button"
        disabled={busy}
        onClick={onEdit}
        className="text-[12.5px] text-rose-light underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-50 motion-safe:disabled:hover:animate-shake"
      >
        edit
      </button>
    </div>
  );
}

/** What the number means, shared by the pill's popover and its mobile sheet. */
function NoveltyExplainer() {
  return (
    <div className="text-left">
      <p className="m-0 text-[13px] leading-relaxed text-fg/85">
        We compare your idea with other teams in this event and a reference set of past projects. A
        higher score means fewer close matches.
      </p>
      <div className="mt-4 mb-1.5 flex h-1.5 overflow-hidden rounded-full" aria-hidden>
        <span className="flex-1 bg-rose/25" />
        <span className="flex-1 bg-rose/55" />
        <span className="flex-1 bg-rose" />
      </div>
      <div className="mb-3.5 flex justify-between text-[10.5px] text-fg/50">
        <span>Similar</span>
        <span>Somewhat similar</span>
        <span>Distinct</span>
      </div>
      <p className="m-0 text-xs leading-relaxed text-fg/55">
        Hackathon ideas can end up looking very similar. This score helps you notice that early and
        try an approach that fewer teams are using. When teams work on different ideas, Code2Create
        is more fun for everyone.
      </p>
    </div>
  );
}

function NoveltyHelp({
  align = "center",
  placement = "below",
}: {
  align?: "start" | "center" | "end";
  placement?: "above" | "below";
}) {
  const [explaining, setExplaining] = useState(false);
  const desktop = useDesktop();
  // The desktop popover goes out through a portal. Rendered inside the card
  // it lives in the scene's `main` stacking context, which sits under the
  // header, so the team circles would paint straight across it.
  const side = placement === "above" ? "top" : "bottom";
  const {
    refs: { setReference, setFloating },
    floatingStyles,
    context,
  } = useFloating({
    open: explaining && desktop,
    onOpenChange: setExplaining,
    placement: align === "center" ? side : `${side}-${align}`,
    whileElementsMounted: autoUpdate,
    middleware: [offset(10), flip({ padding: 12 }), shift({ padding: 12 })],
  });
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([dismiss]);

  return (
    <div className="pointer-events-auto relative flex">
      <button
        ref={setReference}
        type="button"
        aria-label="What this score means"
        aria-expanded={explaining}
        {...getReferenceProps({ onClick: () => setExplaining((value) => !value) })}
        className="flex size-[18px] items-center justify-center rounded-full border border-rose/60 text-[10px] text-rose-light/80 transition-colors hover:border-rose-light hover:text-rose-light"
      >
        ?
      </button>
      {explaining && desktop ? (
        <FloatingPortal>
          <div
            ref={setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-[60] w-[320px] rounded-petal-sm glass-menu bg-wash/90 px-6 py-5 font-normal text-fg"
          >
            <p className="mb-2.5 text-[11px] font-semibold tracking-[.08em] text-rose-light/80">
              What the score means
            </p>
            <NoveltyExplainer />
          </div>
        </FloatingPortal>
      ) : null}
      <Drawer.Root open={explaining && !desktop} onOpenChange={setExplaining}>
        <Drawer.Portal>
          <Drawer.Overlay className="fixed inset-0 z-40 bg-[rgb(6_0_2/.5)]" />
          <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 rounded-tl-box border-t border-petal-edge bg-wash outline-none">
            <div className="mx-auto mt-3 h-1 w-10 rounded-full bg-rose/40" aria-hidden />
            <div className="px-7 pt-5 pb-[calc(28px+env(safe-area-inset-bottom))]">
              <Drawer.Title className="mb-2.5 text-[11px] font-semibold tracking-[.08em] text-rose-light/80">
                What the score means
              </Drawer.Title>
              <Drawer.Description className="sr-only">
                What the idea comparison score means.
              </Drawer.Description>
              <NoveltyExplainer />
            </div>
          </Drawer.Content>
        </Drawer.Portal>
      </Drawer.Root>
    </div>
  );
}

export function NoveltyReviewRow({
  state,
}: {
  state: NoveltyState;
}) {
  const signal = visibleNoveltySignal(state);
  const score = signal?.score ?? null;
  const band = signal?.band ?? null;
  return (
    <div className="border-b border-petal-line pt-4 pb-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[15px] font-semibold text-fg/85">Novelty</span>
        <span
          className="flex items-center gap-2 text-[12.5px] font-semibold text-rose-light"
          aria-live="polite"
        >
          {score === null
            ? state.status === "checking"
              ? "Checking"
              : "Preparing score"
            : <span><LiveNumber value={score} /> / 100{band === null ? "" : ` · ${noveltyBandLabels[band]}`}</span>}
          <NoveltyHelp align="end" />
        </span>
      </div>
      <div className="mt-2.5 h-[3px] overflow-hidden rounded-full bg-petal-line" aria-hidden>
        <div
          className="h-full rounded-full bg-rose-light transition-[width] duration-700"
          style={{ width: score === null ? "18%" : `${Math.max(2, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  );
}

export function NoveltyPill({
  state,
  currentLength,
  minimumLength,
  idleLabel = "keep writing",
}: {
  state: NoveltyState;
  currentLength?: number;
  minimumLength: number | null;
  idleLabel?: string;
}) {
  if (minimumLength === null) return null;
  const belowMinimum = currentLength !== undefined && currentLength < minimumLength;
  const signal = belowMinimum
    ? null
    : state.status === "ready"
      ? state.signal
      : state.status === "checking"
        ? state.previous
        : null;
  const label = belowMinimum || state.status === "idle" ? idleLabel : "checking";
  return (
    <div className="pointer-events-auto relative">
      <div className="inline-flex items-center gap-2 rounded-[9px] border border-rose-light/55 bg-wash/92 py-2 pr-2.5 pl-4 text-[12.5px] font-semibold text-rose-light shadow-[0_8px_22px_var(--shade-1)] backdrop-blur-md">
        <span aria-live="polite" aria-label="Live idea comparison score">
          {signal === null ? (
            label
          ) : signal.band === null ? (
            <><LiveNumber value={signal.score} /> / 100</>
          ) : (
            <>
              {/* Wide screens carry both; phones trade them on a slow tick. */}
              <span className="hidden sm:inline">
                <LiveNumber value={signal.score} /> / 100 · {noveltyBandLabels[signal.band]}
              </span>
              <span className="grid overflow-hidden text-center sm:hidden">
                <span className="col-start-1 row-start-1 animate-[c2cticka_5.6s_ease-in-out_infinite] motion-reduce:animate-none">
                  <LiveNumber value={signal.score} /> / 100
                </span>
                <span className="col-start-1 row-start-1 animate-[c2ctickb_5.6s_ease-in-out_infinite] motion-reduce:hidden">
                  {noveltyBandLabels[signal.band]}
                </span>
              </span>
            </>
          )}
          {signal !== null && state.status === "checking" ? (
            <span className="sr-only">Updating</span>
          ) : null}
        </span>
        <NoveltyHelp align="start" placement="above" />
      </div>
    </div>
  );
}
