import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation } from "convex/react";
import { useState, type ReactNode } from "react";

import { ImportedTeamChoiceView } from "../components/portal/ImportedTeamChoiceView";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";
import { canLeaveCurrentTeam } from "../lib/teamLeave";
import type { CurrentTeam } from "../types";

type PendingTeam = NonNullable<
  NonNullable<FunctionReturnType<typeof api.participants.me>>["pendingTeam"]
>;

export function ImportedTeamChoiceScreen({
  header,
  currentTeam,
  importedTeam,
}: {
  header: ReactNode;
  /** Only when they already made a team here; absent in the usual case. */
  currentTeam?: CurrentTeam;
  importedTeam: PendingTeam;
}) {
  const acceptAssignedTeam = useMutation(api.teams.acceptAssignedTeam);
  const declineAssignedTeam = useMutation(api.participants.declineAssignedTeam);
  const operations = useOperationRunner();
  const [error, setError] = useState<string | null>(null);
  const joining = operations.hasPending("team-assignment-accept");
  const keeping = operations.hasPending("team-assignment-keep");
  const busy = joining || keeping;

  const joinImportedTeam = async () => {
    if ((currentTeam && !canLeaveCurrentTeam(currentTeam)) || busy) return;
    setError(null);
    try {
      await operations.run(
        "team-assignment-accept",
        (clientOperationId) => () =>
          acceptAssignedTeam({
            eventSlug,
            teamRosterEntryId: importedTeam.id,
            expectedEntryVersion: importedTeam.version,
            currentTeam: currentTeam
              ? { id: currentTeam.id, expectedVersion: currentTeam.version }
              : null,
            clientOperationId,
          }),
      );
    } catch (caught) {
      setError(readableError(caught));
    }
  };

  const keepCurrentTeam = async () => {
    if (busy) return;
    setError(null);
    try {
      await operations.run(
        "team-assignment-keep",
        (clientOperationId) => () =>
          declineAssignedTeam({
            eventSlug,
            teamRosterEntryId: importedTeam.id,
            expectedVersion: importedTeam.version,
            clientOperationId,
          }),
      );
    } catch (caught) {
      setError(readableError(caught));
    }
  };

  return (
    <ImportedTeamChoiceView
      header={header}
      {...(currentTeam ? { currentTeam } : {})}
      importedTeam={importedTeam}
      joining={joining}
      keeping={keeping}
      error={error}
      onJoin={() => void joinImportedTeam()}
      onKeep={() => void keepCurrentTeam()}
    />
  );
}
