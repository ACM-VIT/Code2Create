import { LiveNumber } from "../components/LiveNumber";
import {
  githubRepositorySyncStateLabels,
  repositoryKindLabels,
  repositoryKinds,
  type RepositoryKind,
} from "@code2create/domain";
import { api } from "@code2create/backend/api";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FigmaIntegrationPanel } from "../components/FigmaIntegrationPanel";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { GitHubMark } from "../components/dashboard/IntegrationsTile";
import {
  ArchivePrompt,
  ItemList,
  ItemRow,
  OptionRow,
  PendingBar,
  RowAction,
  RowNote,
  SectionLabel,
  ToolNotice,
  ToolSheet,
} from "../components/integrations/ToolKit";
import { PortalButton } from "../components/portal/PortalButton";
import { PortalError, PortalField, PortalInput, PortalSelect } from "../components/portal/PortalField";
import { OutlineHeading } from "../components/portal/OutlineHeading";
import { PortalScene } from "../components/portal/PortalScene";
import {
  TeamCluster,
  type ClusterMember,
  type ClusterTeam,
} from "../components/portal/TeamCluster";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { githubRepositoryAddBlocker, githubRepositorySelectionConnection } from "../lib/githubRepositorySelection";
import { useOperationRunner } from "../lib/operations";
import type {
  AvailableGitHubRepository,
  CurrentGitHubIntegration,
  CurrentTeam,
  CurrentTeamMember,
} from "../types";

type AvailableRepositoryPage = {
  connectionId: CurrentGitHubIntegration["connections"][number]["id"];
  repositories: AvailableGitHubRepository[];
  totalCount: number;
  nextPage?: number;
};

function repositoryKindFromValue(value: string) {
  return repositoryKinds.find((kind) => kind === value);
}

type RepositoryDraft = {
  connectionId: CurrentGitHubIntegration["connections"][number]["id"];
  repository: AvailableGitHubRepository;
  kind: RepositoryKind;
  customKind: string;
  purpose: string;
  trackedBranch: string;
  rootPath: string;
};

type GitHubOperationResult =
  | FunctionReturnType<typeof api.githubActions.addRepository>
  | FunctionReturnType<typeof api.githubIntegrations.refreshRepository>
  | FunctionReturnType<typeof api.githubIntegrations.reorderRepositories>
  | FunctionReturnType<typeof api.githubIntegrations.archiveRepository>;

type PendingGitHubOperation = {
  kind: "add" | "refresh" | "reorder" | "archive";
  slot: string;
  action: string;
};

function parseNavigationState(state: unknown) {
  if (typeof state !== "object" || state === null) return null;
  const connectionId =
    "connectionId" in state && typeof state.connectionId === "string" ? state.connectionId : undefined;
  const repositoryId =
    "repositoryId" in state && typeof state.repositoryId === "string" ? state.repositoryId : undefined;
  const archiveId =
    "archiveId" in state && typeof state.archiveId === "string" ? state.archiveId : undefined;
  return { connectionId, repositoryId, archiveId };
}

export function IntegrationsScreen({
  team,
  members,
  onSignOut,
}: {
  team: CurrentTeam;
  members: readonly CurrentTeamMember[];
  onSignOut: () => void;
}) {
  const integration = useQuery(api.githubIntegrations.current, { eventSlug });
  if (!integration) {
    return (
      <IntegrationsScene team={team} members={members} onSignOut={onSignOut}>
        <p className="m-0 text-[13px] text-fg/55" role="status">
          {integration === undefined
            ? "Loading integrations…"
            : "A team is required before connecting project tools."}
        </p>
      </IntegrationsScene>
    );
  }
  return (
    <ConnectedIntegrations
      key={`${integration.viewerPersonId}:${integration.teamId}:${integration.connections.map(connection => `${connection.id}:${connection.version}:${connection.state}:${connection.canBrowse}`).join(",")}`}
      integration={integration}
      team={team}
      members={members}
      onSignOut={onSignOut}
    />
  );
}

function ConnectedIntegrations({
  integration,
  team,
  members,
  onSignOut,
}: {
  integration: CurrentGitHubIntegration;
  team: CurrentTeam;
  members: readonly CurrentTeamMember[];
  onSignOut: () => void;
}) {
  const beginConnection = useAction(api.githubActions.beginConnection);
  const listRepositories = useAction(api.githubActions.listAvailableRepositories);
  const addRepository = useAction(api.githubActions.addRepository);
  const refreshRepository = useMutation(api.githubIntegrations.refreshRepository);
  const reorderRepositories = useMutation(api.githubIntegrations.reorderRepositories);
  const archiveRepository = useMutation(api.githubIntegrations.archiveRepository);
  const [availableRepositories, setAvailableRepositories] =
    useState<AvailableRepositoryPage | null>(null);
  const [activeConnectionId, setActiveConnectionId] = useState<
    CurrentGitHubIntegration["connections"][number]["id"] | null
  >(null);
  const [draft, setDraft] = useState<RepositoryDraft | null>(null);
  const [archiveId, setArchiveId] = useState<
    CurrentGitHubIntegration["repositories"][number]["id"] | null
  >(null);
  const [archiveReason, setArchiveReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const repositoryRequest = useRef(0);
  const repositoryPickerHeading = useRef<HTMLSpanElement>(null);
  const repositoryDraftHeading = useRef<HTMLSpanElement>(null);
  const commandInFlight = useRef(false);
  const operations = useOperationRunner<GitHubOperationResult>();
  const connectedRepositoryIds = useMemo(
    () => new Set(integration.repositories.map((repository) => repository.repositoryId)),
    [integration.repositories],
  );

  useEffect(() => {
    if (availableRepositories) repositoryPickerHeading.current?.focus();
  }, [availableRepositories?.connectionId]);

  useEffect(() => {
    if (draft) repositoryDraftHeading.current?.focus();
  }, [draft?.repository.repositoryId]);

  const connect = async () => {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    setBusy("connect");
    setError(null);
    try {
      const result = await beginConnection({ eventSlug });
      window.location.assign(result.installUrl);
    } catch (caught) {
      setError(readableError(caught));
      commandInFlight.current = false;
      setBusy(null);
    }
  };

  const loadRepositories = async (
    connectionId: CurrentGitHubIntegration["connections"][number]["id"],
    page = 1,
  ) => {
    const requestNumber = repositoryRequest.current + 1;
    repositoryRequest.current = requestNumber;
    if (page === 1) {
      setAvailableRepositories(null);
      setDraft(null);
    }
    setBusy(connectionId);
    setError(null);
    try {
      const result = await listRepositories({ eventSlug, connectionId, page });
      if (repositoryRequest.current !== requestNumber) return;
      setActiveConnectionId(connectionId);
      setAvailableRepositories((current) => {
        if (page === 1 || current?.connectionId !== connectionId) {
          return { connectionId, ...result };
        }
        const repositories = new Map(
          [...current.repositories, ...result.repositories].map((repository) => [
            repository.repositoryId,
            repository,
          ]),
        );
        return {
          connectionId,
          repositories: [...repositories.values()].sort((left, right) =>
            left.fullName.localeCompare(right.fullName),
          ),
          totalCount: result.totalCount,
          ...(result.nextPage !== undefined ? { nextPage: result.nextPage } : {}),
        };
      });
    } catch (caught) {
      if (repositoryRequest.current !== requestNumber) return;
      setError(readableError(caught));
    } finally {
      if (repositoryRequest.current === requestNumber) setBusy(null);
    }
  };

  const chooseRepository = (
    repository: AvailableGitHubRepository,
    connectionId?: CurrentGitHubIntegration["connections"][number]["id"],
  ) => {
    const targetConnectionId = connectionId ?? activeConnectionId;
    if (!targetConnectionId) return;
    repositoryRequest.current += 1;
    setBusy(null);
    setError(null);
    setActiveConnectionId(targetConnectionId);
    setDraft({
      connectionId: targetConnectionId,
      repository,
      kind: "full_product",
      customKind: "",
      purpose: "",
      trackedBranch: repository.defaultBranch,
      rootPath: "",
    });
  };

  const navState = parseNavigationState(location.state);
  const requestedRepositoryId = navState?.repositoryId ?? searchParams.get("repositoryId");
  const requestedArchiveId = navState?.archiveId ?? searchParams.get("archiveId");
  const archiveTargetId = integration.repositories.find(
    repo => repo.id === requestedArchiveId || repo.repositoryId === requestedArchiveId,
  )?.id;
  const requestedConnection = githubRepositorySelectionConnection(
    integration.connections, navState?.connectionId ?? searchParams.get("connectionId"), requestedRepositoryId,
  );
  const requestedConnectionId = requestedConnection?.id;

  useEffect(() => {
    if (!integration.canManage) return;
    if (archiveTargetId) {
      setArchiveId(archiveTargetId);
      return;
    }
    if (!requestedConnectionId) return;
    if (!requestedRepositoryId) {
      void loadRepositories(requestedConnectionId);
      return () => { repositoryRequest.current += 1; };
    }
    const requestNumber = ++repositoryRequest.current;
    setActiveConnectionId(requestedConnectionId);
    setBusy(requestedConnectionId);
    setDraft(null);
    setError(null);
    void (async () => {
      try {
        let page: number | undefined = 1;
        while (page !== undefined) {
          const result = await listRepositories({ eventSlug, connectionId: requestedConnectionId, page });
          if (requestNumber !== repositoryRequest.current) return;
          const found = result.repositories.find(repo => repo.repositoryId === requestedRepositoryId);
          if (found) {
            chooseRepository(found, requestedConnectionId);
            return;
          }
          page = result.nextPage;
        }
        setError("This repository is not available to your GitHub account. Choose another repository or reconnect GitHub.");
      } catch (caught) {
        if (requestNumber === repositoryRequest.current) setError(readableError(caught));
      } finally {
        if (requestNumber === repositoryRequest.current) setBusy(null);
      }
    })();
    return () => { repositoryRequest.current += 1; };
  }, [location.key, requestedConnectionId, requestedRepositoryId, archiveTargetId, integration.canManage]);

  const saveRepository = async () => {
    if (!draft || !canAdd || commandInFlight.current) return;
    commandInFlight.current = true;
    setBusy("add-repository");
    setError(null);
    try {
      await operations.run(
        "github-repository-add",
        (clientOperationId) => () =>
          addRepository({
            eventSlug,
            connectionId: draft.connectionId,
            repositoryId: draft.repository.repositoryId,
            owner: draft.repository.owner,
            name: draft.repository.name,
            kind: draft.kind,
            ...(draft.kind === "other" ? { customKind: draft.customKind } : {}),
            purpose: draft.purpose,
            trackedBranch: draft.trackedBranch,
            ...(draft.rootPath.trim() ? { rootPath: draft.rootPath } : {}),
            clientOperationId,
          }),
      );
      setDraft(null);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      commandInFlight.current = false;
      setBusy(null);
    }
  };

  const refresh = async (repository: CurrentGitHubIntegration["repositories"][number]) => {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    setBusy(repository.id);
    setError(null);
    try {
      await operations.run(
        "github-repository-refresh",
        (clientOperationId) => () =>
          refreshRepository({
            eventSlug,
            bindingId: repository.id,
            expectedVersion: repository.version,
            reason: "Team requested current GitHub data",
            clientOperationId,
          }),
      );
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      commandInFlight.current = false;
      setBusy(null);
    }
  };

  const archive = async (repository: CurrentGitHubIntegration["repositories"][number]) => {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    setBusy(repository.id);
    setError(null);
    try {
      await operations.run(
        "github-repository-archive",
        (clientOperationId) => () =>
          archiveRepository({
            eventSlug,
            bindingId: repository.id,
            expectedVersion: repository.version,
            reason: archiveReason,
            clientOperationId,
          }),
      );
      setArchiveId(null);
      setArchiveReason("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      commandInFlight.current = false;
      setBusy(null);
    }
  };

  const moveRepository = async (index: number, direction: -1 | 1) => {
    if (commandInFlight.current) return;
    const targetIndex = index + direction;
    const ordered = [...integration.repositories];
    const repository = ordered[index];
    const target = ordered[targetIndex];
    if (!repository || !target) return;
    commandInFlight.current = true;
    ordered[index] = target;
    ordered[targetIndex] = repository;
    setBusy("repository-order");
    setError(null);
    try {
      await operations.run(
        "github-repositories-reorder",
        (clientOperationId) => () =>
          reorderRepositories({
            eventSlug,
            orderedRepositories: ordered.map((item) => ({
              bindingId: item.id,
              expectedVersion: item.version,
            })),
            clientOperationId,
          }),
      );
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      commandInFlight.current = false;
      setBusy(null);
    }
  };

  const pendingOperation: PendingGitHubOperation | null = operations.hasPending(
    "github-repository-add",
  )
    ? { kind: "add", slot: "github-repository-add", action: "Confirm repository" }
    : operations.hasPending("github-repository-refresh")
      ? { kind: "refresh", slot: "github-repository-refresh", action: "Confirm refresh" }
      : operations.hasPending("github-repositories-reorder")
        ? { kind: "reorder", slot: "github-repositories-reorder", action: "Confirm order" }
        : operations.hasPending("github-repository-archive")
          ? { kind: "archive", slot: "github-repository-archive", action: "Confirm removal" }
          : null;

  const clearPendingOperation = (operation: PendingGitHubOperation) => {
    if (operation.kind === "add") setDraft(null);
    if (operation.kind === "archive") {
      setArchiveId(null);
      setArchiveReason("");
    }
  };

  const confirmPendingOperation = (operation: PendingGitHubOperation) => {
    if (commandInFlight.current) return;
    commandInFlight.current = true;
    setBusy(operation.slot);
    setError(null);
    void operations
      .retryPending(operation.slot)
      .then(() => clearPendingOperation(operation))
      .catch((caught: unknown) => {
        if (!operations.hasPending(operation.slot)) clearPendingOperation(operation);
        setError(readableError(caught));
      })
      .finally(() => {
        commandInFlight.current = false;
        setBusy(null);
      });
  };

  const teamAccepted = ["admitted", "confirmed", "checked_in", "active", "completed"].includes(
    integration.teamStatus,
  );
  const addBlocker = githubRepositoryAddBlocker({
    eventStatus: integration.eventStatus,
    canManage: integration.canManage,
    repositoryCount: integration.repositories.length,
    maximumRepositories: integration.policy?.maxActiveRepositories ?? 0,
    freezeAt: integration.policy?.githubFreezeAt,
    now: Date.now(),
  });
  const canAdd = addBlocker === null;
  const activeConnections = integration.connections.filter(
    (connection) => connection.state === "active",
  );

  const summary = integration.summary;
  const grouped = { useGrouping: true } as const;
  const repositoryCount = integration.repositories.length;
  const sheetMeta =
    summary && summary.repositoryCount > 0 ? (
      <>
        <LiveNumber value={summary.repositoryCount} />{" "}
        {summary.repositoryCount === 1 ? "repository" : "repositories"} ·{" "}
        <LiveNumber value={summary.uniqueObservedCommitCount} format={grouped} /> commits ·{" "}
        <LiveNumber value={summary.pushCount} format={grouped} /> pushes · +
        <LiveNumber value={summary.additions} format={grouped} /> −
        <LiveNumber value={summary.deletions} format={grouped} />
      </>
    ) : activeConnections.length > 0 ? (
      activeConnections.map((connection) => connection.accountLogin).join(" · ")
    ) : (
      "the code your team is shipping"
    );
  const connectButton =
    integration.canManage && teamAccepted && integration.policy && integration.githubConfigured ? (
      <PortalButton size="xs" disabled={busy === "connect"} onClick={connect}>
        {busy === "connect" ? "Opening GitHub…" : "Connect GitHub"}
      </PortalButton>
    ) : null;

  return (
    <IntegrationsScene team={team} members={members} onSignOut={onSignOut}>
      {pendingOperation ? (
        <PendingBar
          message={
            busy !== null
              ? "Saving the repository change… keep this page open."
              : "The reply to your last repository change was interrupted."
          }
          action={pendingOperation.action}
          busy={busy !== null}
          onConfirm={() => confirmPendingOperation(pendingOperation)}
        />
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
        <ToolSheet
          mark={<GitHubMark className="size-7" />}
          name="GitHub"
          meta={sheetMeta}
          {...(connectButton ? { action: connectButton } : {})}
        >
          {pendingOperation ? null : (
            <>
              {!teamAccepted ? <ToolNotice>GitHub opens after your team is accepted.</ToolNotice> : null}
              {!integration.policy ? (
                <ToolNotice>Code and design connections aren’t open yet.</ToolNotice>
              ) : null}
              {!integration.githubConfigured ? (
                <ToolNotice>GitHub connections are unavailable right now.</ToolNotice>
              ) : null}
              {teamAccepted && integration.eventStatus !== "live" && integration.policy && integration.githubConfigured ? (
                <ToolNotice>
                  You can connect GitHub and preview a repository now. Adding it to your team opens when organizers start the official build. Draft details are not saved until you add the repository.
                </ToolNotice>
              ) : null}

              {activeConnections.length > 0 ? (
                <ul className="m-0 flex list-none flex-col divide-y divide-petal-line p-0">
                  {activeConnections.map((connection) => (
                    <li
                      key={connection.id}
                      className="flex items-center justify-between gap-4 py-2.5"
                    >
                      <span className="min-w-0 truncate text-[12.5px] text-fg/70">
                        {connection.accountLogin} · {connection.targetType} ·{" "}
                        {connection.repositorySelection === "all"
                          ? "all repositories"
                          : "selected repositories"}
                      </span>
                      {integration.canManage ? (
                        <RowAction
                          disabled={busy === connection.id}
                          onClick={() => connection.canBrowse ? loadRepositories(connection.id) : connect()}
                          className="text-rose-light!"
                        >
                          {busy === connection.id ? "Loading…" : connection.canBrowse ? "Choose repositories" : "Authorize your GitHub"}
                        </RowAction>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}

              {availableRepositories && !draft ? (
                <div className="flex flex-col gap-2">
                  <SectionLabel
                    aside={
                      <>
                        {availableRepositories.repositories.length} / {availableRepositories.totalCount}
                      </>
                    }
                  >
                    <span ref={repositoryPickerHeading} tabIndex={-1} className="outline-none">
                      choose your team’s repositories
                    </span>
                  </SectionLabel>
                  {availableRepositories.repositories.length === 0 ? (
                    <ToolNotice>
                      No repositories are available. Check this app’s repository access in GitHub,
                      including organization approval for private repositories, then try again.
                    </ToolNotice>
                  ) : (
                    <ul className="m-0 flex max-h-96 list-none flex-col divide-y divide-petal-line overflow-y-auto p-0">
                      {availableRepositories.repositories.map((repository) => {
                        const connected = connectedRepositoryIds.has(repository.repositoryId);
                        return (
                          <OptionRow
                            key={repository.repositoryId}
                            title={repository.fullName}
                            detail={connected ? "added" : repository.isPrivate ? "private" : "public"}
                            disabled={connected || !integration.canManage}
                            onSelect={() => chooseRepository(repository)}
                          />
                        );
                      })}
                    </ul>
                  )}
                  {availableRepositories.nextPage !== undefined ? (
                    <RowAction
                      className="self-start text-rose-light!"
                      disabled={busy === availableRepositories.connectionId}
                      onClick={() =>
                        loadRepositories(
                          availableRepositories.connectionId,
                          availableRepositories.nextPage,
                        )
                      }
                    >
                      {busy === availableRepositories.connectionId ? "Loading…" : "Load more"}
                    </RowAction>
                  ) : null}
                </div>
              ) : null}

              {draft ? (
                <div className="flex flex-col gap-4">
                  <SectionLabel><span ref={repositoryDraftHeading} tabIndex={-1} className="outline-none">add {draft.repository.fullName}</span></SectionLabel>
                  {addBlocker ? <ToolNotice>{addBlocker}</ToolNotice> : null}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <PortalField label="What kind of repository is this?">
                      {(id) => (
                        <PortalSelect
                          id={id}
                          value={draft.kind}
                          onValueChange={(value) => {
                            const kind = repositoryKindFromValue(value);
                            if (kind) setDraft((current) => (current ? { ...current, kind } : null));
                          }}
                          options={repositoryKinds.map((kind) => ({
                            value: kind,
                            label: repositoryKindLabels[kind],
                          }))}
                        />
                      )}
                    </PortalField>
                    {draft.kind === "other" ? (
                      <PortalField label="Kind">
                        {(id) => (
                          <PortalInput
                            id={id}
                            value={draft.customKind}
                            maxLength={50}
                            onChange={(event) =>
                              setDraft({ ...draft, customKind: event.target.value })
                            }
                          />
                        )}
                      </PortalField>
                    ) : null}
                    <PortalField label="What does it contain?" className="sm:col-span-2">
                      {(id) => (
                        <PortalInput
                          id={id}
                          value={draft.purpose}
                          maxLength={180}
                          placeholder="Participant web app and shared UI"
                          onChange={(event) => setDraft({ ...draft, purpose: event.target.value })}
                        />
                      )}
                    </PortalField>
                    <PortalField label="Tracked branch">
                      {(id) => (
                        <PortalInput
                          id={id}
                          value={draft.trackedBranch}
                          maxLength={255}
                          onChange={(event) =>
                            setDraft({ ...draft, trackedBranch: event.target.value })
                          }
                        />
                      )}
                    </PortalField>
                    <PortalField label="Project folder, if this is a monorepo">
                      {(id) => (
                        <PortalInput
                          id={id}
                          value={draft.rootPath}
                          maxLength={240}
                          placeholder="apps/web"
                          onChange={(event) => setDraft({ ...draft, rootPath: event.target.value })}
                        />
                      )}
                    </PortalField>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <PortalButton
                      size="xs"
                      disabled={busy === "add-repository"}
                      onClick={() => {
                        setDraft(null);
                        if (!availableRepositories) void loadRepositories(draft.connectionId);
                      }}
                    >
                      Choose another repository
                    </PortalButton>
                    <PortalButton
                      size="xs"
                      variant="solid"
                      disabled={
                        !canAdd ||
                        busy === "add-repository" ||
                        !draft.purpose.trim() ||
                        !draft.trackedBranch.trim() ||
                        (draft.kind === "other" && !draft.customKind.trim())
                      }
                      onClick={saveRepository}
                    >
                      {busy === "add-repository" ? "Checking repository…" : "Add repository"}
                    </PortalButton>
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col gap-1">
                <SectionLabel
                  aside={
                    integration.policy ? (
                      <>
                        <LiveNumber value={repositoryCount} /> / {integration.policy.maxActiveRepositories}
                      </>
                    ) : null
                  }
                >
                  team repositories
                </SectionLabel>
                {repositoryCount === 0 ? (
                  <p className="m-0 mt-2 text-[12.5px] text-fg/55">No repositories have been added.</p>
                ) : (
                  <ItemList>
                    {integration.repositories.map((repository, index) => (
                      <ItemRow
                        key={repository.id}
                        title={repository.fullName}
                        href={repository.url}
                        meta={
                          <>
                            {repository.trackedBranch}
                            {repository.rootPath ? ` / ${repository.rootPath}` : ""} ·{" "}
                            <LiveNumber value={repository.metrics.commitCount} /> commits ·{" "}
                            {repository.topicState === "missing"
                              ? "topic missing"
                              : repository.topicState === "present"
                                ? "topic set"
                                : "topic unchecked"}
                          </>
                        }
                        status={githubRepositorySyncStateLabels[repository.syncState].toLowerCase()}
                        statusTone={
                          repository.syncState === "error" || repository.syncState === "rate_limited"
                            ? "warn"
                            : "quiet"
                        }
                        notes={
                          <>
                            {repository.topicState === "missing" ? (
                              <RowNote>
                                Add <code className="text-fg/75">{repository.requiredTopic}</code> in
                                GitHub, then refresh here.
                              </RowNote>
                            ) : null}
                            {repository.metrics.completeness === "partial" ? (
                              <RowNote>
                                GitHub returned only part of this repository's history; these counts
                                are context, not judging evidence.
                              </RowNote>
                            ) : null}
                            {repository.syncErrorCode ? (
                              <RowNote tone="warn">
                                GitHub could not update this repository. Try again or ask support.
                              </RowNote>
                            ) : null}
                          </>
                        }
                        {...(integration.canManage
                          ? {
                              actions: (
                                <>
                                  <RowAction
                                    aria-label={`Move ${repository.fullName} up`}
                                    disabled={index === 0 || busy !== null}
                                    onClick={() => moveRepository(index, -1)}
                                  >
                                    Up
                                  </RowAction>
                                  <RowAction
                                    aria-label={`Move ${repository.fullName} down`}
                                    disabled={index === repositoryCount - 1 || busy !== null}
                                    onClick={() => moveRepository(index, 1)}
                                  >
                                    Down
                                  </RowAction>
                                  <RowAction disabled={busy !== null} onClick={() => refresh(repository)}>
                                    {busy === repository.id ? "Working…" : "Refresh"}
                                  </RowAction>
                                  <RowAction
                                    tone="danger"
                                    disabled={busy !== null}
                                    onClick={() => setArchiveId(repository.id)}
                                  >
                                    Archive
                                  </RowAction>
                                </>
                              ),
                            }
                          : {})}
                      >
                        {archiveId === repository.id ? (
                          <ArchivePrompt
                            reason={archiveReason}
                            onReason={setArchiveReason}
                            onCancel={() => {
                              setArchiveId(null);
                              setArchiveReason("");
                            }}
                            onConfirm={() => archive(repository)}
                            busy={busy === repository.id}
                            confirmDisabled={!archiveReason.trim()}
                          />
                        ) : null}
                      </ItemRow>
                    ))}
                  </ItemList>
                )}
                {summary && !summary.commitIdentityComplete ? (
                  <RowNote>
                    Some history could not be compared completely, so a shared commit may count
                    more than once.
                  </RowNote>
                ) : null}
              </div>
              <PortalError message={error} />
            </>
          )}
        </ToolSheet>
        <FigmaIntegrationPanel />
      </div>
    </IntegrationsScene>
  );
}

/** The stage for the connected tools: the night scene under one outline word. */
export function IntegrationsScene({
  team,
  members,
  onSignOut,
  children,
}: {
  team: ClusterTeam;
  members: readonly ClusterMember[];
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <PortalScene
      tree="left"
      onSignOut={onSignOut}
      header={<TeamCluster team={team} members={members} />}
    >
      <div className="relative flex w-full max-w-[1000px] flex-1 flex-col gap-7 text-left">
        <header className="flex flex-col gap-3 lg:-mt-12">
          <OutlineHeading word="build" />
          <p className="m-0 text-[12.5px] text-fg/55">
            <Link to="/" viewTransition className="text-rose-light underline-offset-4 hover:underline">
              back home
            </Link>
          </p>
        </header>
        {children}
      </div>
    </PortalScene>
  );
}
