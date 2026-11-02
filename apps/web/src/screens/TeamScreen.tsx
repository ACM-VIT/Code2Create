import { api } from "@code2create/backend/api";
import { useProductAnalytics } from "@code2create/client-observability";
import { useMutation } from "convex/react";
import { useState, type SubmitEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PortalScene } from "../components/portal/PortalScene";
import { PortalButton, PortalTickButton } from "../components/portal/PortalButton";
import { PortalError, PortalInput } from "../components/portal/PortalField";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";

function TeamCard({
  title,
  detail,
  children,
}: {
  title: string;
  detail: string;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col rounded-petal-sm glass-tile px-7 py-6 text-left sm:w-[300px]">
      <p className="mb-1.5 font-display font-light tracking-[-.01em] text-[21px] text-fg/85">
        {title}
      </p>
      <p className="mb-4.5 flex-1 text-[12.5px] leading-relaxed text-fg/60">{detail}</p>
      {children}
    </div>
  );
}

/** Onboarding step three: create a team, or join with a code. */
export function TeamScreen({ header }: { header?: ReactNode }) {
  const params = useParams<{ code?: string }>();
  const navigate = useNavigate();
  const createTeam = useMutation(api.teams.create);
  const joinTeam = useMutation(api.teams.join);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState(params.code ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operations = useOperationRunner();
  const { capture } = useProductAnalytics();
  const createPending = operations.hasPending("team-create");
  const joinPending = operations.hasPending("team-join");
  const operationPending = createPending || joinPending;

  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await operations.run(
        "team-create",
        (clientOperationId) => () => createTeam({ eventSlug, name, clientOperationId }),
      );
      capture("c2c_team_created", { c2c_membership_role: "lead" });
      void navigate("/", { replace: true, viewTransition: true });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const join = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await operations.run(
        "team-join",
        (clientOperationId) => () => joinTeam({ eventSlug, code, clientOperationId }),
      );
      capture("c2c_team_joined", { c2c_membership_role: "member" });
      void navigate("/", { replace: true, viewTransition: true });
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalScene tree="left" {...(header ? { header } : {})}>
      <div className="flex w-full max-w-[660px] flex-col items-center text-center">
        <h1 className="mb-2 font-display font-normal tracking-[-.01em] text-3xl text-shadow-[0_4px_30px_var(--scene-text-glow)] lg:text-[42px]">
          Find your people.
        </h1>
        <p className="mb-8 text-[12.5px] text-fg/50"></p>

        <div className="flex w-full flex-col items-stretch gap-4 sm:flex-row sm:justify-center sm:gap-[18px]">
          <TeamCard title="Create a team" detail="you become the lead">
            {naming ? (
              <form onSubmit={create} className="flex gap-2.5">
                <PortalInput
                  autoFocus
                  required
                  maxLength={80}
                  aria-label="Team name"
                  disabled={operationPending || busy}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Paper Cranes"
                  className="min-w-0 flex-1"
                />
                <PortalTickButton
                  type="submit"
                  label={
                    busy ? "Creating…" : createPending ? "Confirm the team" : "Create the team"
                  }
                  disabled={busy || joinPending || (!createPending && !name.trim())}
                />
              </form>
            ) : (
              <PortalButton
                type="button"
                size="sm"
                className="w-full"
                disabled={operationPending || busy}
                onClick={() => {
                  setNaming(true);
                  setError(null);
                }}
              >
                Start one
              </PortalButton>
            )}
          </TeamCard>

          <TeamCard title="Join a team" detail="paste the code your lead shared">
            <form onSubmit={join} className="flex gap-2.5">
              <PortalInput
                required
                maxLength={7}
                aria-label="Team code"
                disabled={operationPending || busy}
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="C2C7ABC"
                className="min-w-0 flex-1 font-mono font-semibold tracking-[.1em]"
              />
              <PortalTickButton
                type="submit"
                label={busy ? "Joining…" : joinPending ? "Confirm the code" : "Join the team"}
                disabled={busy || createPending || (!joinPending && code.trim().length < 7)}
              />
            </form>
          </TeamCard>
        </div>

        <PortalError message={error} reserve />
        <p className="mt-7 inline-flex items-center gap-1 rounded-full bg-wash/45 px-3.5 py-1.5 text-[12.5px] text-fg/80 backdrop-blur-[6px]">
          can't find a team? join our{" "}
          <a
            href="https://discord.gg/hPkhtMcHq8"
            target="_blank"
            rel="noreferrer"
            className="text-rose-light underline decoration-rose-light/70 decoration-1 underline-offset-2 transition-colors hover:decoration-rose-light"
          >
            Discord
          </a>
        </p>
      </div>
    </PortalScene>
  );
}
