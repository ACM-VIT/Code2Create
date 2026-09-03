import { Tile, TileEyebrow } from "./Tile";

export type IntegrationTarget = "github" | "figma";

export type IntegrationsTileModel = {
  available: boolean;
  github: { connected: boolean; detail: string };
  figma: { connected: boolean; detail: string };
  open: (target: IntegrationTarget) => void;
};

function GitHubMark({ className }: { className: string }) {
  return (
    <svg className={className} aria-hidden>
      <use href="/icons.svg#github-icon" />
    </svg>
  );
}

function FigmaMark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M8.5 2h3.5v6.5H8.5a3.25 3.25 0 0 1 0-6.5Z" />
      <path d="M12 2h3.5a3.25 3.25 0 0 1 0 6.5H12Z" />
      <path d="M8.5 8.75H12v6.5H8.5a3.25 3.25 0 0 1 0-6.5Z" />
      <circle cx="15.5" cy="12" r="3.25" />
      <path d="M8.5 15.5H12v3.25A3.25 3.25 0 1 1 8.5 15.5Z" />
    </svg>
  );
}

function IntegrationButton({
  target,
  label,
  connected,
  detail,
  onOpen,
}: {
  target: IntegrationTarget;
  label: string;
  connected: boolean;
  detail: string;
  onOpen: () => void;
}) {
  const Mark = target === "github" ? GitHubMark : FigmaMark;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex min-w-0 flex-1 items-center gap-3.5 rounded-[14px] border border-rose/45 bg-wash/55 px-4 py-3 text-left backdrop-blur-md transition-colors hover:border-rose-light hover:bg-wash/70 focus-visible:border-rose-light focus-visible:outline-none"
    >
      <span
        className={`flex size-11 flex-none items-center justify-center rounded-full border transition-colors ${
          connected
            ? "border-ring-lead bg-avatar-lead text-rose-light shadow-[0_0_18px_var(--avatar-glow)]"
            : "border-rose/60 bg-avatar text-fg/80 group-hover:text-fg"
        }`}
      >
        <Mark className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] text-fg">{label}</span>
        <span
          className={`block truncate text-[11.5px] ${connected ? "text-rose-light" : "text-fg/55"}`}
        >
          {detail}
        </span>
      </span>
    </button>
  );
}

export function IntegrationsTile({
  model,
  focused,
  onFocus,
  onRelease,
}: {
  model: IntegrationsTileModel;
  focused: boolean;
  onFocus: () => void;
  onRelease: () => void;
}) {
  const summary = !model.available
    ? "Opens once your team is confirmed."
    : `GitHub ${model.github.connected ? "connected" : "not linked"} · Figma ${
        model.figma.connected ? "connected" : "not linked"
      }`;

  return (
    <Tile area="integrations" expanded={focused} onToggle={onFocus} onRelease={onRelease}>
      <div className="flex flex-1 flex-col justify-between gap-3 p-[18px]">
        <div className="flex items-baseline justify-between gap-3">
          <TileEyebrow>integrations</TileEyebrow>
          {!focused ? <span className="text-[11px] text-fg/50">tap to open</span> : null}
        </div>
        <p
          className={`m-0 text-[13px] leading-snug text-fg/70 ${focused ? "max-w-[42ch]" : "line-clamp-2"}`}
        >
          {focused && model.available
            ? "Connect where the team builds, so checkpoints and reviews can see the work as it happens."
            : summary}
        </p>
        {focused ? (
          <div className="overflow-hidden pt-1">
            <div className="flex translate-y-0 flex-col gap-2.5 opacity-100 motion-safe:transition-[transform,opacity] motion-safe:duration-[520ms] motion-safe:ease-[cubic-bezier(.22,1,.36,1)] starting:translate-y-[110%] starting:opacity-0 sm:flex-row">
              <IntegrationButton
                target="github"
                label="GitHub"
                connected={model.github.connected}
                detail={model.available ? model.github.detail : "Not yet"}
                onOpen={() => model.open("github")}
              />
              <IntegrationButton
                target="figma"
                label="Figma"
                connected={model.figma.connected}
                detail={model.available ? model.figma.detail : "Not yet"}
                onOpen={() => model.open("figma")}
              />
            </div>
          </div>
        ) : null}
      </div>
    </Tile>
  );
}
