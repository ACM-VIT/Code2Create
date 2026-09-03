import { safePolygon, useFloating, useHover, useInteractions } from "@floating-ui/react";
import { useState } from "react";
import { useDesktop } from "../../lib/useDesktop";
import { Link } from "react-router-dom";
import { Petal } from "./Petal";
import { usePortalSignOut } from "./portalSceneContext";
import { assignFlowerVariants } from "./flowerVariants";
import { MemberAvatarVisual } from "./MemberAvatarVisual";

// Structural props rather than the generated Convex views: this is a
// presentational component, and Convex `Id<T>` widens to `string`, so real
// query results still satisfy these while fixtures stay constructible.
export type ClusterTeam = {
  name: string;
  publicCode: string;
  activeMemberCount: number;
  teamMaximumSize: number;
  currentMembershipId: string;
};

export type ClusterMember = {
  teamMemberId: string;
  membershipId: string;
  role: string;
  displayName: string;
  githubAvatarUrl?: string | undefined;
};

function Avatar({
  displayName,
  githubAvatarUrl,
  seed,
  lead,
  variant,
  size = "md",
  className = "",
}: {
  displayName: string;
  githubAvatarUrl?: string | undefined;
  seed: string;
  lead: boolean;
  variant?: number;
  size?: "sm" | "md";
  className?: string;
}) {
  // The mockup's 48px stack crowds a 390px header, so it steps down on mobile.
  const box = size === "md" ? "size-10 lg:size-12" : "size-[34px]";
  return (
    <div
      title={displayName}
      className={`relative flex flex-none items-center justify-center rounded-full ${box} ${
        lead ? "border-2 border-ring-lead bg-avatar-lead" : "border-2 border-rose/70 bg-avatar"
      } ${className}`}
    >
      <MemberAvatarVisual
        displayName={displayName}
        githubAvatarUrl={githubAvatarUrl}
        seed={seed}
        lead={lead}
        {...(variant === undefined ? {} : { variant })}
        flowerClassName="size-[62%]"
      />
    </div>
  );
}

/**
 * The top-right team presence: an overlapping avatar stack that opens the
 * roster on hover or focus. Only data the roster query actually returns is
 * shown — name, lead role, the join code, and the seat count.
 */
export function TeamCluster({
  team,
  members,
  editable = true,
  canManage = false,
}: {
  team: ClusterTeam;
  members: readonly ClusterMember[];
  editable?: boolean;
  canManage?: boolean;
}) {
  // Hover previews the roster; a click pins it, while keyboard focus keeps the
  // whole cluster open for tabbing. Keeping those channels separate prevents a
  // pointer-induced focus event from cancelling the click that should pin it.
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [keyboardFocused, setKeyboardFocused] = useState(false);
  const [reference, setReference] = useState<HTMLElement | null>(null);
  const [floating, setFloating] = useState<HTMLDivElement | null>(null);
  const open = pinned || hovered || keyboardFocused;
  const { context } = useFloating({
    elements: { reference, floating },
    open: hovered,
    onOpenChange: setHovered,
    placement: "bottom-end",
  });
  const hover = useHover(context, {
    mouseOnly: true,
    handleClose: safePolygon({ buffer: 1 }),
  });
  const { getFloatingProps, getReferenceProps } = useInteractions([hover]);
  // One deal for the whole roster so no two members share a bloom.
  const flowerVariants = assignFlowerVariants(
    members.filter((member) => member.role !== "lead").map((member) => member.membershipId),
  );

  // Every face fits on a wide screen; a phone header shows three and a count
  // once the stack would pass four.
  const desktop = useDesktop();
  const shown = !desktop && members.length > 4 ? members.slice(0, 3) : members;
  const hidden = members.slice(shown.length);

  return (
    <div
      className="relative text-right"
      data-ph-sensitive
      onFocus={(event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.matches(":focus-visible")) {
          setKeyboardFocused(true);
        }
      }}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        setPinned(false);
        setKeyboardFocused(false);
      }}
    >
      <div
        ref={setReference}
        className="flex items-start justify-end"
        {...getReferenceProps({ onPointerDown: () => setKeyboardFocused(false) })}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-label={`Team ${team.name}, ${team.activeMemberCount} of ${team.teamMaximumSize} members`}
          onClick={() => setPinned((value) => !value)}
          className="block cursor-pointer rounded-lg"
        >
          <div className="avatar-stack justify-end">
            {shown.map((member) => {
              const variant = flowerVariants.get(member.membershipId);
              return (
                <Avatar
                  key={member.teamMemberId}
                  displayName={member.displayName}
                  githubAvatarUrl={member.githubAvatarUrl}
                  seed={member.membershipId}
                  lead={member.role === "lead"}
                  {...(variant === undefined ? {} : { variant })}
                />
              );
            })}
            {hidden.length > 0 ? (
              <div
                title={hidden.map((member) => member.displayName).join(", ")}
                className="flex size-10 flex-none items-center justify-center rounded-full bg-fg/15 font-ui text-[13px] text-fg/80 lg:size-12 lg:text-sm"
              >
                +{hidden.length}
              </div>
            ) : null}
          </div>
          <p className="mt-2 hidden font-ui font-normal text-[13.5px] text-rose-light sm:block">
            {team.name}
          </p>
        </button>
      </div>

      {open ? (
        <div
          ref={setFloating}
          className="absolute right-0 top-[96px] z-10 w-[300px] max-w-[calc(100vw-40px)] text-left lg:top-[104px]"
          {...getFloatingProps()}
        >
          <TeamRosterPanel
            team={team}
            members={members}
            editable={editable}
            canManage={canManage}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The join code as a one-tap copy. */
function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title="Copy the join code"
      onClick={() => {
        void navigator.clipboard.writeText(code).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      className="font-mono text-[12.5px] tracking-[.12em] text-rose-light transition-colors hover:text-fg"
    >
      {copied ? "copied" : code}
    </button>
  );
}

/**
 * The team details card: name, seat count, the roster, and the join code or
 * sealed line with the team-page link. The cluster shows it as its popover;
 * the mobile menu takeover shows the same card full-width.
 */
export function TeamRosterPanel({
  team,
  members,
  editable = true,
  canManage = false,
}: {
  team: ClusterTeam;
  members: readonly ClusterMember[];
  editable?: boolean;
  canManage?: boolean;
}) {
  const flowerVariants = assignFlowerVariants(
    members.filter((member) => member.role !== "lead").map((member) => member.membershipId),
  );
  const onSignOut = usePortalSignOut();
  return (
    <div className="rounded-petal-sm glass-menu px-5 py-4 text-left">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-ui font-normal text-base text-rose-light">{team.name}</span>
        <span className="text-[10.5px] font-semibold tracking-[.08em] text-fg/50">
          {team.activeMemberCount} of {team.teamMaximumSize}
        </span>
      </div>
      {/* Preflight is off, so a bare ul keeps the UA's 40px indent. */}
      <ul className="m-0 list-none p-0">
        {members.map((member) => {
          const isYou = member.membershipId === team.currentMembershipId;
          const variant = flowerVariants.get(member.membershipId);
          return (
            <li key={member.teamMemberId} className="flex items-center gap-3 py-2">
              <Avatar
                displayName={member.displayName}
                githubAvatarUrl={member.githubAvatarUrl}
                seed={member.membershipId}
                lead={member.role === "lead"}
                {...(variant === undefined ? {} : { variant })}
                size="sm"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] font-semibold">{member.displayName}</div>
                <div
                  className={`text-[10.5px] ${
                    member.role === "lead" || isYou
                      ? "font-ui font-normal text-rose-light"
                      : "text-fg/50"
                  }`}
                >
                  {[member.role === "lead" ? "lead" : null, isYou ? "you" : null]
                    .filter(Boolean)
                    .join(" · ") || "member"}
                </div>
              </div>
              {member.role === "lead" ? <Petal size={13} /> : null}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center justify-between gap-3 border-t border-petal-line pt-3">
        {editable ? (
          <CopyCode code={team.publicCode} />
        ) : (
          <p className="m-0 text-[11.5px] text-fg/50">changes closed</p>
        )}
        <Link
          to="/team"
          viewTransition
          className="flex-none text-[11.5px] text-fg/55 no-underline transition-colors hover:text-rose-light"
        >
          {canManage && editable ? "manage team" : "view team"}
        </Link>
      </div>
      {onSignOut ? (
        /* The account row: everything else, and the way out — here, under the
           avatars, instead of as more circles in the header. */
        <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-petal-line pt-2.5 text-[11.5px]">
          <div className="flex items-center gap-3.5">
            <Link
              to="/"
              viewTransition
              className="text-fg/55 no-underline transition-colors hover:text-rose-light"
            >
              home
            </Link>
            <Link
              to="/more"
              viewTransition
              className="text-fg/55 no-underline transition-colors hover:text-rose-light"
            >
              more
            </Link>
          </div>
          <button
            type="button"
            onClick={onSignOut}
            className="text-fg/45 transition-colors hover:text-rose-light"
          >
            sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
