import { useEffect, useState } from "react";
import { LoadingLine, ShimmerLabel } from "./GuideLoader";
import { GuideMarkdown } from "./GuideMarkdown";
import { elapsedName } from "./guideTime";

export type GuideStep = {
  key: string;
  label: string;
  state: "running" | "done" | "failed";
};

const autoCloseDelayMs = 1_000;

export function GuideReasoning({
  reasoning,
  steps,
  streaming,
  startedAt,
  thoughtForMs,
}: {
  reasoning: string;
  steps: readonly GuideStep[];
  streaming: boolean;
  startedAt?: number | undefined;
  thoughtForMs?: number | undefined;
}) {
  // Open on its own while the work streams in and for a beat after; once the
  // reader toggles it, their choice wins.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [settled, setSettled] = useState(!streaming);
  useEffect(() => {
    if (streaming) return;
    const timer = window.setTimeout(() => setSettled(true), autoCloseDelayMs);
    return () => window.clearTimeout(timer);
  }, [streaming]);
  const open = chosen ?? (streaming || !settled);

  const hasBody = reasoning.trim().length > 0 || steps.length > 0;
  const summary = [
    thoughtForMs === undefined
      ? "Thought for a moment"
      : `Thought for ${elapsedName(thoughtForMs)}`,
    steps.length > 0 ? `${steps.length} ${steps.length === 1 ? "step" : "steps"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mb-3">
      {streaming ? (
        <LoadingLine label="Thinking" startedAt={startedAt} />
      ) : (
        <button
          type="button"
          disabled={!hasBody}
          aria-expanded={open}
          onClick={() => setChosen(!open)}
          className="inline-flex items-center gap-1.5 rounded-sm text-[12px] text-fg/50 transition-colors enabled:hover:text-fg disabled:cursor-default"
        >
          {summary}
          {hasBody ? (
            <svg
              viewBox="0 0 24 24"
              aria-hidden
              className={`size-3.5 fill-none stroke-current stroke-[2] transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="m6 9 6 6 6-6" />
            </svg>
          ) : null}
        </button>
      )}

      {hasBody ? (
        <div
          className={`grid transition-[grid-template-rows,opacity] duration-300 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none ${
            open ? "mt-2.5 grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="pl-0.5">
              {steps.length > 0 ? (
                <ol className="m-0 mb-2 flex list-none flex-col gap-1.5 p-0 last:mb-0">
                  {steps.map((step) => (
                    <li
                      key={step.key}
                      className={`text-[12px] ${step.state === "failed" ? "text-rose-light" : "text-fg/60"}`}
                    >
                      {step.state === "running" ? (
                        <ShimmerLabel>{step.label}</ShimmerLabel>
                      ) : (
                        step.label
                      )}
                    </li>
                  ))}
                </ol>
              ) : null}
              {reasoning.trim().length > 0 ? (
                <GuideMarkdown text={reasoning.trim()} officialLinks={[]} tone="thinking" />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
