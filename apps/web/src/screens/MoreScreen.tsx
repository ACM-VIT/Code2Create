import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useQuery } from "convex/react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Flower } from "../components/portal/FlowerAvatar";
import { PetalCard } from "../components/portal/PetalCard";
import { PortalScene } from "../components/portal/PortalScene";
import { eventSlug } from "../lib/config";
import type { ParticipantMe } from "../types";

type ParticipantCapabilities = FunctionReturnType<typeof api.access.participantCapabilities>;
type SupportSummary = FunctionReturnType<typeof api.support.mineSummary>;

function supportRowValue(summary: SupportSummary | undefined) {
  if (summary === undefined) return "…";
  if (summary.openCount === 0) return "Help desk";
  return `${summary.countIsLowerBound ? "20+" : summary.openCount} open`;
}

function Row({
  label,
  value,
  to,
  href,
}: {
  label: string;
  value?: ReactNode;
  to?: string;
  href?: string;
}) {
  const body = (
    <>
      <span className="text-[14px] text-fg/90">{label}</span>
      <span className="min-w-0 truncate text-right text-[12px] text-fg/50">{value}</span>
    </>
  );
  const base =
    "flex w-full items-center justify-between gap-4 border-b border-petal-line py-3.5 text-left no-underline transition-colors last:border-b-0";
  if (to) {
    return (
      <Link to={to} viewTransition className={`${base} hover:text-rose-light`}>
        {body}
      </Link>
    );
  }
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className={`${base} hover:text-rose-light`}>
        {body}
      </a>
    );
  }
  return <div className={base}>{body}</div>;
}

/**
 * Mockup f12: everything else, one quiet list. Sign-out lives in the header
 * badge or cluster like everywhere else, so the list is only destinations.
 */
export function MoreScreen({
  me,
  capabilities,
  showIntegrations,
  showMusic,
  header,
  onSignOut,
}: {
  me: ParticipantMe;
  capabilities: ParticipantCapabilities;
  showIntegrations: boolean;
  showMusic: boolean;
  header: ReactNode;
  onSignOut: () => void;
}) {
  const delivery = useQuery(
    api.participantNotifications.mine,
    capabilities?.notifications ? { eventSlug } : "skip",
  );
  const communications = useQuery(
    api.participantCommunications.current,
    showIntegrations || showMusic ? { eventSlug } : "skip",
  );
  const support = useQuery(
    api.support.mineSummary,
    capabilities?.supportRead ? { eventSlug } : "skip",
  );
  const policy = me.participantPolicy.policy;
  const fullName = me.profile?.fullName ?? me.person.displayName;
  const participantClass =
    me.membership?.participantClass === "vit_student" ? "VIT student" : "External participant";
  const profileMeta = [participantClass, me.profile?.vitRegistrationNumber]
    .filter(Boolean)
    .join(" · ");

  return (
    <PortalScene tree="left" header={header} onSignOut={onSignOut}>
      <div className="flex w-full max-w-[480px] flex-col items-center">
        <h1 className="mb-7 font-display font-light tracking-[-.01em] text-3xl text-shadow-[0_4px_30px_var(--scene-text-glow)] lg:text-[40px]">
          More
        </h1>
        <PetalCard className="w-full px-6 py-2">
          {/* You, at the head of the list. */}
          <div className="flex items-center gap-4 border-b border-petal-line py-4">
            <span className="flex size-11 flex-none items-center justify-center rounded-full border-2 border-rose/70 bg-avatar">
              <Flower seed={me.membership?.id ?? me.person.verifiedEmail} className="size-[62%]" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="m-0 text-[15px] text-fg">{fullName}</p>
              <p className="m-0 mt-0.5 text-[12px] leading-snug wrap-anywhere text-fg/55">
                {me.person.verifiedEmail}
              </p>
              <p className="m-0 mt-0.5 text-[11.5px] text-rose-light/80">{profileMeta}</p>
            </div>
            <Link
              to="/more/profile"
              viewTransition
              className="flex-none text-[12.5px] text-rose-light no-underline hover:underline"
            >
              Edit profile
            </Link>
          </div>

          {capabilities?.notifications ? (
            <Row
              label="Notifications"
              value={
                delivery === undefined
                  ? "…"
                  : delivery === null
                    ? "Email updates"
                    : `Email · ${delivery.state.replace(/_/g, " ")}`
              }
            />
          ) : null}
          {showIntegrations ? (
            <Row label="Integrations" value="Repos and Figma" to="/integrations" />
          ) : null}
          {communications?.discordUrl ? (
            <Row
              label="Discord"
              value={communications.discordLabel}
              href={communications.discordUrl}
            />
          ) : null}
          {showMusic ? <Row label="Music" value="Synesthesia" to="/music" /> : null}
          {capabilities?.supportRead ? (
            <Row label="Support" value={supportRowValue(support)} to="/support" />
          ) : null}
          <Row label="Privacy" value="Notice" href={policy.privacyNoticeUrl} />
        </PetalCard>
        <p className="mt-5 text-[11.5px] text-fg/45">
          <Link to="/" viewTransition className="text-rose-light no-underline">
            back home
          </Link>
        </p>
      </div>
    </PortalScene>
  );
}
