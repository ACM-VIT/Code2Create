import { repositoryKinds, type RepositoryKind } from '@code2create/domain'
import { api } from '@code2create/backend/api'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useMemo, useRef, useState } from 'react'
import { FigmaIntegrationPanel } from '../components/FigmaIntegrationPanel'
import { ErrorNotice } from '../components/Form'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import type {
  AvailableGitHubRepository,
  CurrentGitHubIntegration,
} from '../types'

type AvailableRepositoryPage = {
  connectionId: CurrentGitHubIntegration['connections'][number]['id']
  repositories: AvailableGitHubRepository[]
  totalCount: number
  nextPage?: number
}

const repositoryKindLabels: Record<RepositoryKind, string> = {
  full_product: 'Full product',
  frontend: 'Frontend',
  backend_api: 'Backend or API',
  mobile_app: 'Mobile app',
  desktop_app: 'Desktop app',
  ai_ml: 'AI or ML',
  data_pipeline: 'Data pipeline',
  hardware_firmware: 'Hardware or firmware',
  infrastructure: 'Infrastructure',
  library_sdk: 'Library or SDK',
  docs_research: 'Docs or research',
  other: 'Other',
}

function repositoryKindFromValue(value: string) {
  return repositoryKinds.find((kind) => kind === value)
}

type RepositoryDraft = {
  connectionId: CurrentGitHubIntegration['connections'][number]['id']
  repository: AvailableGitHubRepository
  kind: RepositoryKind
  customKind: string
  purpose: string
  trackedBranch: string
  rootPath: string
}

export function IntegrationsScreen() {
  const integration = useQuery(api.githubIntegrations.current, { eventSlug })
  const beginConnection = useAction(api.githubActions.beginConnection)
  const listRepositories = useAction(api.githubActions.listAvailableRepositories)
  const addRepository = useAction(api.githubActions.addRepository)
  const refreshRepository = useMutation(api.githubIntegrations.refreshRepository)
  const reorderRepositories = useMutation(api.githubIntegrations.reorderRepositories)
  const archiveRepository = useMutation(api.githubIntegrations.archiveRepository)
  const [availableRepositories, setAvailableRepositories] =
    useState<AvailableRepositoryPage | null>(null)
  const [activeConnectionId, setActiveConnectionId] = useState<
    CurrentGitHubIntegration['connections'][number]['id'] | null
  >(null)
  const [draft, setDraft] = useState<RepositoryDraft | null>(null)
  const [archiveId, setArchiveId] = useState<
    CurrentGitHubIntegration['repositories'][number]['id'] | null
  >(null)
  const [archiveReason, setArchiveReason] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const repositoryRequest = useRef(0)
  const operations = useOperationRunner()
  const connectedRepositoryIds = useMemo(
    () => new Set(integration?.repositories.map((repository) => repository.repositoryId) ?? []),
    [integration?.repositories],
  )

  if (integration === undefined) {
    return <p className="muted" role="status">Loading integrations…</p>
  }
  if (!integration) {
    return <p className="muted">A team is required before connecting project tools.</p>
  }

  const connect = async () => {
    setBusy('connect')
    setError(null)
    try {
      const result = await beginConnection({ eventSlug })
      window.location.assign(result.installUrl)
    } catch (caught) {
      setError(readableError(caught))
      setBusy(null)
    }
  }

  const loadRepositories = async (
    connectionId: CurrentGitHubIntegration['connections'][number]['id'],
    page = 1,
  ) => {
    const requestNumber = repositoryRequest.current + 1
    repositoryRequest.current = requestNumber
    setBusy(connectionId)
    setError(null)
    try {
      const result = await listRepositories({ eventSlug, connectionId, page })
      if (repositoryRequest.current !== requestNumber) return
      setActiveConnectionId(connectionId)
      setAvailableRepositories((current) => {
        if (page === 1 || current?.connectionId !== connectionId) {
          return { connectionId, ...result }
        }
        const repositories = new Map(
          [...current.repositories, ...result.repositories].map((repository) => [
            repository.repositoryId,
            repository,
          ]),
        )
        return {
          connectionId,
          repositories: [...repositories.values()].sort((left, right) =>
            left.fullName.localeCompare(right.fullName),
          ),
          totalCount: result.totalCount,
          ...(result.nextPage !== undefined ? { nextPage: result.nextPage } : {}),
        }
      })
      setDraft(null)
    } catch (caught) {
      if (repositoryRequest.current !== requestNumber) return
      setError(readableError(caught))
    } finally {
      if (repositoryRequest.current === requestNumber) setBusy(null)
    }
  }

  const chooseRepository = (repository: AvailableGitHubRepository) => {
    if (!activeConnectionId) return
    setDraft({
      connectionId: activeConnectionId,
      repository,
      kind: 'full_product',
      customKind: '',
      purpose: '',
      trackedBranch: repository.defaultBranch,
      rootPath: '',
    })
  }

  const saveRepository = async () => {
    if (!draft) return
    setBusy('add-repository')
    setError(null)
    try {
      await operations.run('github-repository-add', (clientOperationId) => () => addRepository({
          eventSlug,
          connectionId: draft.connectionId,
          repositoryId: draft.repository.repositoryId,
          owner: draft.repository.owner,
          name: draft.repository.name,
          kind: draft.kind,
          ...(draft.kind === 'other' ? { customKind: draft.customKind } : {}),
          purpose: draft.purpose,
          trackedBranch: draft.trackedBranch,
          ...(draft.rootPath.trim() ? { rootPath: draft.rootPath } : {}),
          clientOperationId,
        }))
      setDraft(null)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (repository: CurrentGitHubIntegration['repositories'][number]) => {
    setBusy(repository.id)
    setError(null)
    try {
      await operations.run('github-repository-refresh', (clientOperationId) => () => refreshRepository({
          eventSlug,
          bindingId: repository.id,
          expectedVersion: repository.version,
          reason: 'Team requested current GitHub data',
          clientOperationId,
        }))
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const archive = async (repository: CurrentGitHubIntegration['repositories'][number]) => {
    setBusy(repository.id)
    setError(null)
    try {
      await operations.run('github-repository-archive', (clientOperationId) => () => archiveRepository({
          eventSlug,
          bindingId: repository.id,
          expectedVersion: repository.version,
          reason: archiveReason,
          clientOperationId,
        }))
      setArchiveId(null)
      setArchiveReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const moveRepository = async (index: number, direction: -1 | 1) => {
    const targetIndex = index + direction
    const ordered = [...integration.repositories]
    const repository = ordered[index]
    const target = ordered[targetIndex]
    if (!repository || !target) return
    ordered[index] = target
    ordered[targetIndex] = repository
    setBusy('repository-order')
    setError(null)
    try {
      await operations.run('github-repositories-reorder', (clientOperationId) => () => reorderRepositories({
          eventSlug,
          orderedRepositories: ordered.map((item) => ({
            bindingId: item.id,
            expectedVersion: item.version,
          })),
          clientOperationId,
        }))
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const teamAccepted = ['admitted', 'confirmed', 'checked_in', 'active', 'completed'].includes(
    integration.teamStatus,
  )
  const canAdd = integration.eventStatus === 'live'
  const activeConnections = integration.connections.filter(
    (connection) => connection.state === 'active',
  )

  return (
    <section className="integration-shell">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Your build</p>
          <h1>Code and design</h1>
          <p className="lead">Connect the code and design files your team is building during the event.</p>
        </div>
        {integration.canManage && teamAccepted && integration.policy && integration.githubConfigured ? (
          <button type="button" className="secondary" disabled={busy === 'connect'} onClick={connect}>
            {busy === 'connect' ? 'Opening GitHub…' : 'Connect GitHub'}
          </button>
        ) : null}
      </div>

      {!teamAccepted ? <p className="notice">GitHub opens after your team is accepted.</p> : null}
      {!integration.policy ? (
        <p className="notice">The event integration policy has not been published.</p>
      ) : null}
      {!integration.githubConfigured ? (
        <p className="notice">GitHub connections are unavailable right now.</p>
      ) : null}
      {teamAccepted && !canAdd && integration.policy && integration.githubConfigured ? (
        <p className="notice">You can connect GitHub now. Repository baselines open at the official build start.</p>
      ) : null}

      {integration.summary && integration.summary.repositoryCount > 0 ? (
        <div className="repository-card">
          <div className="repository-card-heading">
            <div>
              <h2>Team code activity</h2>
              <p>Current totals across the shared repository set.</p>
            </div>
            <span className={`status-dot ${integration.summary.health}`}>
              {integration.summary.completeness}
            </span>
          </div>
          <dl className="repository-facts">
            <div>
              <dt>Repositories</dt>
              <dd>{integration.summary.completeRepositoryCount} / {integration.summary.repositoryCount} complete</dd>
            </div>
            <div>
              <dt>Topics ready</dt>
              <dd>{integration.summary.topicPresentCount} / {integration.summary.repositoryCount}</dd>
            </div>
            <div>
              <dt>Observed unique commits</dt>
              <dd>
                {integration.summary.uniqueObservedCommitCount.toLocaleString()}
                {integration.summary.commitIdentityComplete ? '' : '+'}
              </dd>
            </div>
            <div>
              <dt>Pushes</dt>
              <dd>{integration.summary.pushCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Changes</dt>
              <dd>+{integration.summary.additions.toLocaleString()} −{integration.summary.deletions.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Changed files</dt>
              <dd>{integration.summary.changedFiles.toLocaleString()}</dd>
            </div>
          </dl>
          {integration.summary.kindCounts.length > 0 ? (
            <p className="fine-print">
              {integration.summary.kindCounts
                .map((item) => `${repositoryKindLabels[item.kind]} ${item.count}`)
                .join(' · ')}
            </p>
          ) : null}
          {integration.summary.languageBytes.length > 0 ? (
            <p className="fine-print">
              Languages: {integration.summary.languageBytes.slice(0, 5).map((item) => item.language).join(', ')}
            </p>
          ) : null}
          {integration.summary.commitOverlapCount > 0 ? (
            <p className="fine-print">
              {integration.summary.commitOverlapCount.toLocaleString()} commit occurrences overlap across connected repositories and count once here.
            </p>
          ) : null}
          {!integration.summary.commitIdentityComplete ? (
            <p className="fine-print">
              Unique commit coverage is partial because at least one comparison exceeded the bounded response or tracks only a project folder.
            </p>
          ) : null}
        </div>
      ) : null}

      {activeConnections.length > 0 ? (
        <div className="connection-list">
          {activeConnections.map((connection) => (
            <div className="connection-row" key={connection.id}>
              <div>
                <span>{connection.accountLogin}</span>
                <small>{connection.targetType} · {connection.repositorySelection} repositories</small>
              </div>
              {integration.canManage ? (
                <button
                  type="button"
                  className="secondary compact"
                  disabled={busy === connection.id}
                  onClick={() => loadRepositories(connection.id)}
                >
                  {busy === connection.id ? 'Loading…' : 'Choose repositories'}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {availableRepositories ? (
        <div className="repository-picker">
          <div className="subheading-row">
            <h2>Available repositories</h2>
            <span>{availableRepositories.repositories.length} / {availableRepositories.totalCount}</span>
          </div>
          {availableRepositories.repositories.length === 0 ? (
            <p className="muted">No repositories are available to this installation.</p>
          ) : (
            <div className="repository-options">
              {availableRepositories.repositories.map((repository) => {
                const connected = connectedRepositoryIds.has(repository.repositoryId)
                return (
                  <button
                    type="button"
                    className="repository-option"
                    key={repository.repositoryId}
                    disabled={connected || !canAdd}
                    onClick={() => chooseRepository(repository)}
                  >
                    <span>{repository.fullName}</span>
                    <small>{connected ? 'Already added' : repository.isPrivate ? 'Private' : 'Public'}</small>
                  </button>
                )
              })}
            </div>
          )}
          {availableRepositories.nextPage !== undefined ? (
            <button
              type="button"
              className="secondary"
              disabled={busy === availableRepositories.connectionId}
              onClick={() => loadRepositories(
                availableRepositories.connectionId,
                availableRepositories.nextPage,
              )}
            >
              {busy === availableRepositories.connectionId ? 'Loading…' : 'Load more repositories'}
            </button>
          ) : null}
        </div>
      ) : null}

      {draft ? (
        <div className="repository-form">
          <div>
            <p className="eyebrow">Add repository</p>
            <h2>{draft.repository.fullName}</h2>
          </div>
          <label className="field">
            <span className="field-label">What kind of repository is this?</span>
            <select
              value={draft.kind}
              onChange={(event) => {
                const kind = repositoryKindFromValue(event.target.value)
                if (kind) setDraft((current) => current ? { ...current, kind } : null)
              }}
            >
              {repositoryKinds.map((kind) => <option key={kind} value={kind}>{repositoryKindLabels[kind]}</option>)}
            </select>
          </label>
          {draft.kind === 'other' ? (
            <label className="field">
              <span className="field-label">Kind</span>
              <input value={draft.customKind} maxLength={50} onChange={(event) => setDraft({ ...draft, customKind: event.target.value })} />
            </label>
          ) : null}
          <label className="field form-span">
            <span className="field-label">What does it contain?</span>
            <input
              value={draft.purpose}
              maxLength={180}
              placeholder="Participant web app and shared UI"
              onChange={(event) => setDraft({ ...draft, purpose: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Tracked branch</span>
            <input value={draft.trackedBranch} maxLength={255} onChange={(event) => setDraft({ ...draft, trackedBranch: event.target.value })} />
          </label>
          <label className="field">
            <span className="field-label">Project folder, if this is a monorepo</span>
            <input value={draft.rootPath} maxLength={240} placeholder="apps/web" onChange={(event) => setDraft({ ...draft, rootPath: event.target.value })} />
          </label>
          <div className="form-actions form-span">
            <button type="button" className="secondary" disabled={busy === 'add-repository'} onClick={() => setDraft(null)}>Cancel</button>
            <button
              type="button"
              className="primary"
              disabled={
                busy === 'add-repository' ||
                !draft.purpose.trim() ||
                !draft.trackedBranch.trim() ||
                (draft.kind === 'other' && !draft.customKind.trim())
              }
              onClick={saveRepository}
            >
              {busy === 'add-repository' ? 'Checking repository…' : 'Add repository'}
            </button>
          </div>
        </div>
      ) : null}

      <div className="repository-list">
        <div className="subheading-row">
          <h2>Team repositories</h2>
          {integration.policy ? (
            <span>{integration.repositories.length} / {integration.policy.maxActiveRepositories}</span>
          ) : null}
        </div>
        {integration.repositories.length === 0 ? (
          <p className="muted">No repositories have been added.</p>
        ) : (
          integration.repositories.map((repository, index) => (
            <article className="repository-card" key={repository.id}>
              <div className="repository-card-heading">
                <div>
                  <a href={repository.url} target="_blank" rel="noreferrer">{repository.fullName}</a>
                  <p>{repositoryKindLabels[repository.kind]} · {repository.purpose}</p>
                </div>
                <span className={`status-dot ${repository.syncState}`}>{repository.syncState}</span>
              </div>
              <dl className="repository-facts">
                <div><dt>Branch</dt><dd>{repository.trackedBranch}{repository.rootPath ? ` / ${repository.rootPath}` : ''}</dd></div>
                <div><dt>Topic</dt><dd>{repository.topicState === 'present' ? 'Ready' : `Add ${repository.requiredTopic}`}</dd></div>
                <div><dt>Commits</dt><dd>{repository.metrics.commitCount}</dd></div>
                <div><dt>Changed files</dt><dd>{repository.metrics.changedFiles}</dd></div>
              </dl>
              {repository.topicState === 'missing' ? (
                <p className="fine-print">Add <code>{repository.requiredTopic}</code> in GitHub, then refresh here.</p>
              ) : null}
              {repository.metrics.completeness === 'partial' ? (
                <p className="fine-print">Some provider results are partial. Counts remain context, not judging evidence.</p>
              ) : null}
              {repository.syncErrorCode ? <p className="fine-print quiet-danger">{repository.syncErrorCode.replaceAll('_', ' ')}</p> : null}
              {integration.canManage ? (
                <div className="repository-actions">
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Move ${repository.fullName} up`}
                    disabled={index === 0 || busy !== null}
                    onClick={() => moveRepository(index, -1)}
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    aria-label={`Move ${repository.fullName} down`}
                    disabled={index === integration.repositories.length - 1 || busy !== null}
                    onClick={() => moveRepository(index, 1)}
                  >
                    Down
                  </button>
                  <button type="button" className="text-button" disabled={busy !== null} onClick={() => refresh(repository)}>
                    {busy === repository.id ? 'Working…' : 'Refresh'}
                  </button>
                  <button type="button" className="text-button quiet-danger" disabled={busy !== null} onClick={() => setArchiveId(repository.id)}>Archive</button>
                </div>
              ) : null}
              {archiveId === repository.id ? (
                <div className="archive-confirmation">
                  <label className="field">
                    <span className="field-label">Why are you removing it?</span>
                    <input value={archiveReason} maxLength={180} onChange={(event) => setArchiveReason(event.target.value)} />
                  </label>
                  <div className="button-row">
                    <button type="button" className="secondary compact" onClick={() => { setArchiveId(null); setArchiveReason('') }}>Cancel</button>
                    <button type="button" className="primary compact" disabled={!archiveReason.trim() || busy === repository.id} onClick={() => archive(repository)}>Archive</button>
                  </div>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
      <ErrorNotice message={error} />
      <FigmaIntegrationPanel />
    </section>
  )
}
