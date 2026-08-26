import { api } from '@code2create/backend/api'
import { figmaFileSyncStateLabels } from '@code2create/domain'
import { useAction, useMutation, useQuery } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useState } from 'react'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import type { CurrentFigmaIntegration } from '../types'
import { ErrorNotice } from './Form'

type FigmaOperationResult =
  | FunctionReturnType<typeof api.figmaActions.addFile>
  | FunctionReturnType<typeof api.figmaIntegrations.refreshFile>
  | FunctionReturnType<typeof api.figmaIntegrations.archiveFile>

function captureTime(value: number) {
  return new Date(value).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function FigmaIntegrationPanel() {
  const integration = useQuery(api.figmaIntegrations.current, { eventSlug })
  const beginConnection = useAction(api.figmaActions.beginConnection)
  const addFile = useAction(api.figmaActions.addFile)
  const refreshFile = useMutation(api.figmaIntegrations.refreshFile)
  const archiveFile = useMutation(api.figmaIntegrations.archiveFile)
  const [selectedConnectionId, setSelectedConnectionId] = useState<
    CurrentFigmaIntegration['connections'][number]['id'] | null
  >(null)
  const [fileUrl, setFileUrl] = useState('')
  const [archiveId, setArchiveId] = useState<
    CurrentFigmaIntegration['files'][number]['id'] | null
  >(null)
  const [archiveTargetId, setArchiveTargetId] = useState<CurrentFigmaIntegration['files'][number]['id'] | null>(null)
  const [refreshId, setRefreshId] = useState<CurrentFigmaIntegration['files'][number]['id'] | null>(null)
  const [archiveReason, setArchiveReason] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const operations = useOperationRunner<FigmaOperationResult>()
  const addPending = operations.hasPending('figma-file-add')
  const refreshPending = operations.hasPending('figma-file-refresh')
  const archivePending = operations.hasPending('figma-file-archive')
  const operationPending = addPending || refreshPending || archivePending

  if (integration === undefined) {
    return <p className="muted" role="status">Loading Figma…</p>
  }
  if (!integration) return null

  const activeConnections = integration.connections.filter(
    (connection) => connection.state === 'active' && connection.credentialState === 'active',
  )
  const selectedConnection = activeConnections.find(
    (connection) => connection.id === selectedConnectionId,
  ) ?? activeConnections[0]
  const teamAccepted = ['admitted', 'confirmed', 'checked_in', 'active', 'completed'].includes(
    integration.teamStatus,
  )
  const canAdd = integration.eventStatus === 'live'

  const connect = async () => {
    setBusy('figma-connect')
    setError(null)
    try {
      const result = await beginConnection({ eventSlug })
      window.location.assign(result.authorizeUrl)
    } catch (caught) {
      setError(readableError(caught))
      setBusy(null)
    }
  }

  const saveFile = async () => {
    if (!addPending && !selectedConnection) return
    setBusy('figma-add')
    setError(null)
    try {
      await operations.run('figma-file-add', (clientOperationId) => {
        if (!selectedConnection) throw new Error('The Figma connection is no longer available.')
        return () => addFile({
          eventSlug,
          credentialConnectionId: selectedConnection.id,
          fileUrl,
          clientOperationId,
        })
      })
      setFileUrl('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (file: CurrentFigmaIntegration['files'][number]) => {
    if (refreshPending && refreshId !== file.id) return
    if (!refreshPending) setRefreshId(file.id)
    setBusy(file.id)
    setError(null)
    try {
      await operations.run('figma-file-refresh', (clientOperationId) => () => refreshFile({
          eventSlug,
          bindingId: file.id,
          expectedVersion: file.version,
          reason: 'Team requested current Figma data',
          clientOperationId,
        }))
      setRefreshId(null)
    } catch (caught) {
      if (!operations.hasPending('figma-file-refresh')) setRefreshId(null)
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const archive = async (file: CurrentFigmaIntegration['files'][number]) => {
    if (archivePending && archiveTargetId !== file.id) return
    if (!archivePending) setArchiveTargetId(file.id)
    setBusy(file.id)
    setError(null)
    try {
      await operations.run('figma-file-archive', (clientOperationId) => () => archiveFile({ eventSlug, bindingId: file.id, expectedVersion: file.version, reason: archiveReason, clientOperationId }))
      setArchiveId(null)
      setArchiveTargetId(null)
      setArchiveReason('')
    } catch (caught) {
      if (!operations.hasPending('figma-file-archive')) setArchiveTargetId(null)
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const retryMissingArchive = async () => {
    setBusy('figma-archive-recovery')
    setError(null)
    try {
      await operations.retryPending('figma-file-archive')
      setArchiveId(null)
      setArchiveTargetId(null)
      setArchiveReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const retryMissingRefresh = async () => {
    setBusy('figma-refresh-recovery')
    setError(null)
    try {
      await operations.retryPending('figma-file-refresh')
      setRefreshId(null)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const retryMissingAdd = async () => {
    setBusy('figma-add-recovery')
    setError(null)
    try {
      await operations.retryPending('figma-file-add')
      setFileUrl('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="provider-section" aria-labelledby="figma-heading">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">Design files</p>
          <h2 id="figma-heading">Figma</h2>
          <p className="muted">Add every file the team is actively using.</p>
        </div>
        {integration.canManage && teamAccepted && integration.policy && integration.figmaConfigured ? (
          <button
            type="button"
            className="secondary"
            disabled={busy !== null || operationPending}
            onClick={connect}
          >
            {busy === 'figma-connect' ? 'Opening Figma…' : 'Connect Figma'}
          </button>
        ) : null}
      </div>

      {!teamAccepted ? (
        <p className="notice">Figma opens after your team is accepted.</p>
      ) : null}
      {!integration.policy ? (
        <p className="notice">The event code and design policy has not been published.</p>
      ) : null}
      {!integration.figmaConfigured ? (
        <p className="notice">Figma connections are unavailable right now.</p>
      ) : null}
      {teamAccepted && !canAdd && integration.policy && integration.figmaConfigured ? (
        <p className="notice">You can connect Figma now. File baselines open at the official build start.</p>
      ) : null}

      {integration.summary && integration.summary.fileCount > 0 ? (
        <div className="repository-card">
          <div className="repository-card-heading">
            <div>
              <h3>Team design activity</h3>
              <p>Current totals across the shared Figma files.</p>
            </div>
            <span className={`status-dot ${integration.summary.health}`}>
              {integration.summary.completeness}
            </span>
          </div>
          <dl className="repository-facts">
            <div>
              <dt>Files</dt>
              <dd>{integration.summary.completeFileCount} / {integration.summary.fileCount} complete</dd>
            </div>
            <div>
              <dt>Frames</dt>
              <dd>{integration.summary.frameCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Components</dt>
              <dd>{(integration.summary.componentCount + integration.summary.componentSetCount).toLocaleString()}</dd>
            </div>
            <div>
              <dt>Design nodes</dt>
              <dd>{integration.summary.nodeCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Frame previews</dt>
              <dd>{integration.summary.availablePreviewCount} / {integration.summary.selectedPreviewCount}</dd>
            </div>
            <div>
              <dt>Comments</dt>
              <dd>{integration.summary.commentCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Open threads</dt>
              <dd>{integration.summary.unresolvedCommentCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Named versions</dt>
              <dd>{integration.summary.versionCount.toLocaleString()}</dd>
            </div>
          </dl>
          {integration.summary.dirtyCount > 0 ? (
            <p className="fine-print">Files behind current Figma metadata: {integration.summary.dirtyCount}.</p>
          ) : null}
          {integration.summary.previewAttentionCount > 0 ? (
            <p className="fine-print">Files with incomplete frame previews: {integration.summary.previewAttentionCount}.</p>
          ) : null}
        </div>
      ) : null}

      {activeConnections.length > 0 ? (
        <div className="repository-form compact-form">
          {activeConnections.length > 1 ? (
            <label className="field">
              <span className="field-label">Figma connection</span>
              <select
                disabled={busy !== null || operationPending}
                value={selectedConnection?.id ?? ''}
                onChange={(event) => {
                  const connection = activeConnections.find(
                    (item) => item.id === event.target.value,
                  )
                  if (connection) setSelectedConnectionId(connection.id)
                }}
              >
                {activeConnections.map((connection, index) => (
                  <option value={connection.id} key={connection.id}>Figma account {index + 1}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field form-span">
            <span className="field-label">Figma file link</span>
            <input
              value={fileUrl}
              disabled={busy !== null || operationPending}
              maxLength={2048}
              placeholder="https://www.figma.com/design/…"
              onChange={(event) => setFileUrl(event.target.value)}
            />
          </label>
          <div className="form-actions form-span">
            <button
              type="button"
              className="primary"
              disabled={
                busy !== null ||
                refreshPending ||
                archivePending ||
                (!addPending && (!canAdd || !fileUrl.trim()))
              }
              onClick={saveFile}
            >
              {busy === 'figma-add' ? 'Reading file…' : addPending ? 'Confirm earlier file' : 'Add file'}
            </button>
          </div>
        </div>
      ) : teamAccepted && integration.policy && integration.figmaConfigured ? (
        <p className="muted">Connect a Figma account to add a file.</p>
      ) : null}

      <div className="repository-list">
        <div className="subheading-row">
          <h3>Team files</h3>
          {integration.policy ? (
            <span>{integration.files.length} / {integration.policy.maxActiveFiles}</span>
          ) : null}
        </div>
        {integration.files.length === 0 ? (
          <p className="muted">No Figma files have been added.</p>
        ) : (
          integration.files.map((file) => (
            <article className="repository-card" key={file.id}>
              <div className="repository-card-heading">
                <div>
                  <a href={file.url} target="_blank" rel="noreferrer">{file.name}</a>
                  <p>{file.editorType} · {file.role} access</p>
                </div>
                <span className={`status-dot ${file.syncState}`}>
                  {figmaFileSyncStateLabels[file.syncState]}
                </span>
              </div>
              <dl className="repository-facts">
                <div><dt>Pages</dt><dd>{file.metrics.pageCount}</dd></div>
                <div><dt>Frames</dt><dd>{file.metrics.frameCount}</dd></div>
                <div><dt>Components</dt><dd>{file.metrics.componentCount + file.metrics.componentSetCount}</dd></div>
                <div><dt>Comments</dt><dd>{file.metrics.commentCount}</dd></div>
              </dl>
              <p className="fine-print">
                Checked {captureTime(file.lastMetadataCheckAt)} · full snapshot {captureTime(file.lastFullCaptureAt)} · {file.webhookState === 'active' ? 'live and scheduled checks' : 'scheduled checks'}
              </p>
              {file.contentDirty ? (
                <p className="fine-print">Figma has newer changes than the saved full checkpoint.</p>
              ) : null}
              {file.rateLimitRetryAt ? (
                <p className="fine-print quiet-danger">Full checkpoint limited. Next retry: {captureTime(file.rateLimitRetryAt)}.</p>
              ) : null}
              {file.metadataRateLimitRetryAt ? (
                <p className="fine-print quiet-danger">Metadata check limited. Next retry: {captureTime(file.metadataRateLimitRetryAt)}.</p>
              ) : file.metadataErrorCode ? (
                <p className="fine-print quiet-danger">
                  Figma could not check this file's latest details. Try again or reconnect Figma.
                </p>
              ) : null}
              {file.metrics.completeness === 'partial' ? (
                <p className="fine-print">Version history is partial; the portal does not present it as a complete count.</p>
              ) : null}
              {file.syncErrorCode ? (
                <p className="fine-print quiet-danger">
                  Figma could not update the saved file evidence. Try again or ask support.
                </p>
              ) : null}
              {integration.canManage ? (
                <div className="repository-actions">
                  <button
                    type="button"
                    className="text-button"
                    disabled={
                      busy !== null ||
                      addPending ||
                      archivePending ||
                      (refreshPending && refreshId !== file.id)
                    }
                    onClick={() => refresh(file)}
                  >
                    {busy === file.id
                      ? 'Working…'
                      : refreshPending && refreshId === file.id
                        ? 'Confirm earlier refresh'
                        : 'Refresh'}
                  </button>
                  <button
                    type="button"
                    className="text-button quiet-danger"
                    disabled={busy !== null || operationPending}
                    onClick={() => setArchiveId(file.id)}
                  >Archive</button>
                </div>
              ) : null}
              {archiveId === file.id || (archivePending && archiveTargetId === file.id) ? (
                <div className="archive-confirmation">
                  <label className="field">
                    <span className="field-label">Why are you removing it?</span>
                    <input disabled={busy !== null || operationPending} value={archiveReason} maxLength={180} onChange={(event) => setArchiveReason(event.target.value)} />
                  </label>
                  <div className="button-row">
                    <button type="button" className="secondary compact" disabled={busy !== null || operationPending} onClick={() => { setArchiveId(null); setArchiveReason('') }}>Cancel</button>
                    <button
                      type="button"
                      className="primary compact"
                      disabled={busy !== null || addPending || refreshPending || (!archivePending && !archiveReason.trim())}
                      onClick={() => archive(file)}
                    >{archivePending && archiveTargetId === file.id ? 'Confirm earlier archive' : 'Archive'}</button>
                  </div>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
      {archivePending && archiveTargetId && !integration.files.some((file) => file.id === archiveTargetId) ? (
        <div className="archive-confirmation">
          <p>The file is no longer active. Confirm the earlier archive response before continuing.</p>
          <button
            type="button"
            className="primary compact"
            disabled={busy !== null}
            onClick={() => void retryMissingArchive()}
          >
            {busy === 'figma-archive-recovery' ? 'Confirming…' : 'Confirm earlier archive'}
          </button>
        </div>
      ) : null}
      {refreshPending && refreshId && !integration.files.some((file) => file.id === refreshId) ? (
        <div className="archive-confirmation">
          <p>The file changed while its refresh response was unavailable.</p>
          <button
            type="button"
            className="primary compact"
            disabled={busy !== null}
            onClick={() => void retryMissingRefresh()}
          >
            {busy === 'figma-refresh-recovery' ? 'Confirming…' : 'Confirm earlier refresh'}
          </button>
        </div>
      ) : null}
      {addPending && (!selectedConnection || !canAdd) ? (
        <div className="archive-confirmation">
          <p>Confirm the earlier file addition before changing the Figma setup.</p>
          <button
            type="button"
            className="primary compact"
            disabled={busy !== null}
            onClick={() => void retryMissingAdd()}
          >
            {busy === 'figma-add-recovery' ? 'Confirming…' : 'Confirm earlier file'}
          </button>
        </div>
      ) : null}
      <ErrorNotice message={error} />
    </section>
  )
}
