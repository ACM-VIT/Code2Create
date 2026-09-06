import { useState, type ReactNode } from "react";
import { LiveNumber } from "../LiveNumber";

import { Reveal, Tile, TileEyebrow } from "./Tile";
import { tileBody } from "./tileClasses";
import type { Slot } from "./dashboardLayout";

export type IntegrationTarget = "github" | "figma";

export type IntegrationRepository = {
  id: string;
  fullName: string;
  url: string;
  connectionId?: string;
};

export type IntegrationsTileModel = {
  /** False until the team can connect tools at all. */
  available: boolean;
  github: {
    connected: boolean;
    detail: ReactNode;
    repositories: readonly IntegrationRepository[];
  };
  figma: { connected: boolean; detail: ReactNode };
  open: (target: IntegrationTarget, repository?: IntegrationRepository) => void;
};

export function GitHubMark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

export function FigmaMark({ className }: { className: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden fill="currentColor">
      <path d="M15.852 8.981h-4.588V0h4.588c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.491-4.49 4.491zM12.735 7.51h3.117c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-3.117V7.51zm0 1.471H8.148c-2.476 0-4.49-2.014-4.49-4.49S5.672 0 8.148 0h4.588v8.981zm-4.587-7.51c-1.665 0-3.019 1.355-3.019 3.019s1.354 3.02 3.019 3.02h3.117V1.471H8.148zm4.587 15.019H8.148c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h4.588v8.98zM8.148 8.981c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h3.117V8.981H8.148zM8.172 24c-2.489 0-4.515-2.014-4.515-4.49s2.014-4.49 4.49-4.49h4.588v4.441c0 2.503-2.047 4.539-4.563 4.539zm-.024-7.51a3.023 3.023 0 0 0-3.019 3.019c0 1.665 1.365 3.019 3.044 3.019 1.705 0 3.093-1.376 3.093-3.068v-2.97H8.148zm7.704 0h-.098c-2.476 0-4.49-2.014-4.49-4.49s2.014-4.49 4.49-4.49h.098c2.476 0 4.49 2.014 4.49 4.49s-2.014 4.49-4.49 4.49zm-.097-7.509c-1.665 0-3.019 1.355-3.019 3.019s1.355 3.019 3.019 3.019h.098c1.665 0 3.019-1.355 3.019-3.019s-1.355-3.019-3.019-3.019h-.098z" />
    </svg>
  );
}

function IntegrationOrb({
  target,
  connected,
  detail,
  onOpen,
}: {
  target: IntegrationTarget;
  connected: boolean;
  detail: ReactNode;
  onOpen: () => void;
}) {
  const Mark = target === "github" ? GitHubMark : FigmaMark;
  const label = target === "github" ? "GitHub" : "Figma";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${connected ? "Manage" : "Connect"} ${label}`}
      className="group flex min-w-0 cursor-pointer flex-col items-center gap-1.5 rounded-xl border-0 bg-transparent p-0 text-center focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-rose-light"
    >
      <span className={`integration-orb-mark flex size-12 shrink-0 items-center justify-center rounded-full border transition-[transform,border-color,color] duration-300 motion-safe:group-hover:-translate-y-0.5 group-hover:border-rose-light ${connected ? "border-ring-lead bg-avatar-lead text-rose-light" : "border-rose/60 bg-avatar text-fg/80 group-hover:text-fg"}`}>
        <Mark className="size-[19px]" />
      </span>
      <span className="text-[11.5px] leading-none text-fg/80">{label}</span>
      <span className={`integration-orb-detail max-w-full truncate text-[10.5px] leading-snug ${connected ? "text-rose-light" : "text-fg/45"}`}>{connected ? detail : "not connected"}</span>
    </button>
  );
}

function ActionButton({ children, onClick }: {
  children: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-none rounded-full border border-rose/55 bg-wash/35 px-3 py-1 text-[11px] text-rose-light transition-colors hover:border-rose-light hover:bg-fg/8"
    >
      {children}
    </button>
  );
}

function GitHubRepositoryManager({
  model,
  addControl,
  onBack,
  onManage,
}: {
  model: IntegrationsTileModel["github"];
  addControl: ReactNode;
  onBack: () => void;
  onManage: (repository?: IntegrationRepository) => void;
}) {
  return (
    <Reveal key="github-manager" className="flex min-h-0 flex-1 flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to integrations"
          className="flex size-7 flex-none items-center justify-center rounded-full border border-rose/40 bg-wash/30 text-fg/65 hover:border-rose-light hover:text-fg"
        >
          <span aria-hidden>←</span>
        </button>
        <div className="min-w-0 flex-1 basis-11">
          <p className="m-0 text-[13px] text-fg">GitHub</p>
          <p className="m-0 truncate text-[10.5px] text-fg/45">
            {!model.connected
              ? "Not connected"
              : model.repositories.length === 1
                ? "1 repo connected"
                : <><LiveNumber value={model.repositories.length} /> repos connected</>}
          </p>
        </div>
        {model.connected ? addControl : <ActionButton onClick={onManage}>Connect</ActionButton>}
      </div>

      {model.connected ? (
        model.repositories.length === 0 ? (
          <p className="m-0 text-[10.5px] text-fg/45">No repositories connected.</p>
        ) : (
          <div className="grid gap-1">
            {model.repositories.map((repository) => (
              <div
                key={repository.id}
                className="flex items-center gap-2 rounded-lg border border-rose/20 bg-fg/4 px-2 py-1"
              >
                <a
                  href={repository.url}
                  target="_blank"
                  rel="noreferrer"
                  className="min-w-0 flex-1 truncate text-[10.5px] text-fg/80 underline-offset-4 hover:text-rose-light hover:underline"
                >
                  {repository.fullName}
                </a>
                <button
                  type="button"
                  onClick={() => onManage(repository)}
                  className="flex-none text-[10px] text-fg/45 hover:text-rose-light"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )
      ) : null}
    </Reveal>
  );
}

/** Repository selection lives on the integrations page, not in a second cached picker. */
export function IntegrationsTile({ slot, model }: {
  slot: Slot;
  model: IntegrationsTileModel;
}) {
  const [view, setView] = useState<"providers" | "github">("providers");
  return (
    <Tile slot={slot} open={view === "github"}>
      <div className={tileBody}>
        {view === "providers" || !model.available ? <TileEyebrow>Integrations</TileEyebrow> : null}
        {!model.available ? (
          <p className="m-0 text-[13px] leading-snug text-fg/65">Opens once your team is confirmed.</p>
        ) : view === "github" ? (
          <GitHubRepositoryManager
            model={model.github}
            addControl={<ActionButton onClick={() => model.open("github")}>Choose repositories</ActionButton>}
            onBack={() => setView("providers")}
            onManage={(repo) => model.open("github", repo)}
          />
        ) : (
          <Reveal key="providers" className="grid w-full max-w-[224px] grid-cols-2 items-start gap-4">
            <IntegrationOrb
              target="github"
              connected={model.github.connected}
              detail={model.github.detail}
              onOpen={() => model.github.repositories.length === 0 ? model.open("github") : setView("github")}
            />
            <IntegrationOrb
              target="figma"
              connected={model.figma.connected}
              detail={model.figma.detail}
              onOpen={() => model.open("figma")}
            />
          </Reveal>
        )}
      </div>
    </Tile>
  );
}
