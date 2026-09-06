import { useEffect, useState } from "react";

import { Flower } from "../components/portal/FlowerAvatar";
import { OutlineHeading } from "../components/portal/OutlineHeading";
import { PortalScene } from "../components/portal/PortalScene";
import { RoomNav } from "../components/portal/RoomNav";
import { TeamCluster, type ClusterMember, type ClusterTeam } from "../components/portal/TeamCluster";

export type ShowcaseProject = {
  id: string;
  name: string;
  team: string;
  track: string;
  tagline: string;
  blurb: string;
  tags: readonly string[];
  members: readonly { name: string; seed: string }[];
  links: { github?: string; demo?: string };
  featured?: boolean;
};

function Members({ members, size = 26 }: { members: ShowcaseProject["members"]; size?: number }) {
  return (
    <span className="flex items-center">
      {members.map((member, index) => (
        <span
          key={member.seed}
          title={member.name}
          style={{ marginLeft: index === 0 ? 0 : -size * 0.3, width: size, height: size }}
          className="flex items-center justify-center rounded-full border-[1.5px] border-rose/70 bg-avatar"
        >
          <Flower seed={member.seed} className="size-[62%]" />
        </span>
      ))}
    </span>
  );
}

function Tags({ tags, className = "" }: { tags: readonly string[]; className?: string }) {
  return (
    <p className={`m-0 text-[12px] text-fg/45 ${className}`}>
      {tags.map((tag, index) => (
        <span key={tag}>
          {index > 0 ? <span className="mx-1.5 text-rose/60">·</span> : null}
          {tag}
        </span>
      ))}
    </p>
  );
}

const iconLink =
  "flex size-8 items-center justify-center rounded-full border border-petal-line text-fg/60 no-underline transition-colors duration-250 hover:border-rose-light hover:text-fg hover:no-underline";

function LinkIcons({ links }: { links: ShowcaseProject["links"] }) {
  const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
  return (
    <span className="flex items-center gap-1.5">
      {links.github ? (
        <a href={links.github} target="_blank" rel="noreferrer" aria-label="Source on GitHub" onClick={stop} className={iconLink}>
          <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
            <path d="M8 .2a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38v-1.34c-2.23.48-2.7-1.08-2.7-1.08-.36-.92-.89-1.17-.89-1.17-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.71 1.22 1.87.87 2.33.66.07-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48v2.2c0 .21.15.46.55.38A8 8 0 0 0 8 .2Z" />
          </svg>
        </a>
      ) : null}
      {links.demo ? (
        <a href={links.demo} target="_blank" rel="noreferrer" aria-label="Open the demo" onClick={stop} className={iconLink}>
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path
              d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7 9"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      ) : null}
    </span>
  );
}

function ProjectCard({
  project,
  featured = false,
  onOpen,
}: {
  project: ShowcaseProject;
  featured?: boolean;
  onOpen: () => void;
}) {
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      style={{ viewTransitionName: `showcase-${project.id}` }}
      className={`showcase-card group relative flex min-w-0 cursor-pointer flex-col rounded-petal glass text-left transition-[border-color,transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:border-rose-light hover:shadow-[0_24px_50px_-28px_var(--glow-rose)] focus-visible:border-rose-light focus-visible:outline-none ${
        featured ? "sm:col-span-2 lg:flex-row lg:items-stretch" : ""
      }`}
    >
      <div className={`flex min-w-0 flex-1 flex-col gap-5 p-6 ${featured ? "lg:p-8" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <Members members={project.members} size={featured ? 32 : 28} />
          <LinkIcons links={project.links} />
        </div>
        <div className="min-w-0">
          <p className="m-0 text-[12px] text-rose-light">
            {project.team}
            <span className="text-fg/35"> · {project.track}</span>
          </p>
          <h2
            className={`m-0 mt-1 font-display font-light tracking-[-.015em] text-fg transition-colors duration-300 group-hover:text-rose-light ${
              featured ? "text-[32px] leading-[1.05] lg:text-[44px]" : "text-[24px] leading-tight"
            }`}
          >
            {project.name}
          </h2>
          <p
            className={`m-0 mt-2.5 text-fg/65 ${
              featured ? "text-[15px] leading-relaxed" : "line-clamp-2 text-[13px] leading-snug"
            }`}
          >
            {project.tagline}
          </p>
        </div>
        <Tags tags={project.tags} className="mt-auto" />
      </div>
      {featured ? (
        <div className="flex flex-col justify-between gap-6 border-t border-petal-line px-6 py-6 lg:w-[38%] lg:border-t-0 lg:border-l lg:px-8 lg:py-8">
          <p className="m-0 line-clamp-6 text-[13.5px] leading-relaxed text-fg/60">{project.blurb}</p>
          <p className="m-0 text-[12.5px] text-fg/50">
            {project.members.map((member) => member.name).join(", ")}
          </p>
        </div>
      ) : null}
    </article>
  );
}

function ProjectSheet({ project, onClose }: { project: ShowcaseProject; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal
      aria-label={project.name}
      onClick={onClose}
      className="showcase-sheet-backdrop fixed inset-0 z-[40] flex items-end justify-center bg-ink/50 p-3 backdrop-blur-sm sm:items-center sm:p-6"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="showcase-sheet relative flex max-h-[calc(100dvh-24px)] w-full max-w-[640px] flex-col gap-5 overflow-y-auto rounded-petal glass bg-wash/70 p-7 shadow-[0_40px_90px_-30px_var(--shade-2)] backdrop-blur-[28px] lg:p-9"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 flex size-9 items-center justify-center rounded-full border border-rose/50 text-fg/80 transition-[color,border-color] duration-300 hover:border-rose-light hover:text-fg"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden>
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <div className="pr-10">
          <p className="m-0 text-[12px] text-rose-light">
            {project.team}
            <span className="text-fg/35"> · {project.track}</span>
          </p>
          <h2 className="m-0 mt-1 font-display font-light text-3xl tracking-[-.015em] lg:text-4xl">
            {project.name}
          </h2>
        </div>
        <p className="m-0 text-[15px] leading-relaxed text-fg/85">{project.tagline}</p>
        <p className="m-0 text-[13.5px] leading-relaxed text-fg/60">{project.blurb}</p>
        <Tags tags={project.tags} />
        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-petal-line pt-5">
          <div className="flex items-center gap-3">
            <Members members={project.members} size={30} />
            <p className="m-0 text-[12.5px] text-fg/60">
              {project.members.map((member) => member.name).join(", ")}
            </p>
          </div>
          <div className="flex gap-2">
            {project.links.demo ? (
              <a
                href={project.links.demo}
                target="_blank"
                rel="noreferrer"
                className="rounded-btn bg-rose px-5 py-2.5 font-ui text-[13px] font-semibold text-wash no-underline hover:brightness-105 hover:no-underline"
              >
                Open demo
              </a>
            ) : null}
            {project.links.github ? (
              <a
                href={project.links.github}
                target="_blank"
                rel="noreferrer"
                className="rounded-btn border-[1.5px] border-rose px-5 py-2.5 font-ui text-[13px] font-semibold text-rose-light no-underline transition-[background,color] duration-250 hover:bg-rose hover:text-wash hover:no-underline"
              >
                Source
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The showcase: every team's project on one wall. Plain glass cards, the
 * featured build spanning two columns, a track filter, and a card opens
 * into a sheet with the full write-up and links.
 */
export function ShowcaseScreen({
  team,
  members,
  teamEditable,
  onSignOut,
  projects,
}: {
  team: ClusterTeam;
  members: readonly ClusterMember[];
  teamEditable: boolean;
  onSignOut: () => void;
  projects: readonly ShowcaseProject[];
}) {
  const [track, setTrack] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const tracks = [...new Set(projects.map((project) => project.track))];
  const visible = track === null ? projects : projects.filter((project) => project.track === track);
  const ordered = [...visible].sort((a, b) => Number(b.featured ?? false) - Number(a.featured ?? false));
  const open = openId === null ? null : (projects.find((project) => project.id === openId) ?? null);

  return (
    <PortalScene
      tree="left"
      onSignOut={onSignOut}
      header={<TeamCluster team={team} members={members} editable={teamEditable} />}
      nav={<RoomNav current="showcase" />}
    >
      <div className="relative flex w-full max-w-[1200px] flex-1 flex-col text-left">
        <header className="showcase-heading relative z-[1] flex flex-col gap-4">
          <OutlineHeading word="showcase" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="m-0 text-[13px] text-fg/60">
              {projects.length === 0
                ? "Nothing on the wall yet."
                : `${projects.length} ${projects.length === 1 ? "build" : "builds"} from this year's teams.`}
            </p>
            {tracks.length > 1 ? (
              <div role="group" aria-label="Track" className="flex flex-wrap gap-1.5">
                {[null, ...tracks].map((option) => {
                  const active = option === track;
                  return (
                    <button
                      key={option ?? "all"}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setTrack(option)}
                      className={`rounded-full border px-3.5 py-1.5 font-ui text-[12px] font-semibold transition-[background,color,border-color] duration-250 ${
                        active
                          ? "border-rose bg-rose text-wash"
                          : "border-petal-line text-rose-light hover:border-rose-light hover:text-fg"
                      }`}
                    >
                      {option ?? "All"}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </header>

        {projects.length === 0 ? (
          <div className="mt-10 rounded-[18px] border border-dashed border-petal-edge/60 px-8 py-16 text-center">
            <p className="m-0 font-display text-xl text-fg/80">The wall is bare for now.</p>
            <p className="m-0 mt-2 text-[13px] text-fg/55">
              No projects have been published to the showcase yet.
            </p>
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
            {ordered.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                featured={track === null && (project.featured ?? false)}
                onOpen={() => setOpenId(project.id)}
              />
            ))}
          </div>
        )}
      </div>
      {open ? <ProjectSheet project={open} onClose={() => setOpenId(null)} /> : null}
    </PortalScene>
  );
}
