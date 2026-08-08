import { api } from '@code2create/backend/api'
import { useAction, useMutation, useQuery } from 'convex/react'
import { useState } from 'react'
import { eventSlug } from '../lib/config'
import { operationId, readableError } from '../lib/errors'
import type { CurrentFigmaIntegration } from '../types'
import { ErrorNotice } from './Form'

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
  const [archiveReason, setArchiveReason] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    if (!selectedConnection) return
    setBusy('figma-add')
    setError(null)
    try {
      await addFile({
        eventSlug,
        credentialConnectionId: selectedConnection.id,
        fileUrl,
        clientOperationId: operationId('figma-file-add'),
      })
      setFileUrl('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const refresh = async (file: CurrentFigmaIntegration['files'][number]) => {
    setBusy(file.id)
    setError(null)
    try {
      await refreshFile({
        eventSlug,
        bindingId: file.id,
        expectedVersion: file.version,
        reason: 'Team requested current Figma data',
        clientOperationId: operationId('figma-file-refresh'),
      })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(null)
    }
  }

  const archive = async (file: CurrentFigmaIntegration['files'][number]) => {
    setBusy(file.id)
    setError(null)
    try {
      await archiveFile({
        eventSlug,
        bindingId: file.id,
        expectedVersion: file.version,
        reason: archiveReason,
        clientOperationId: operationId('figma-file-archive'),
      })
      setArchiveId(null)
      setArchiveReason('')
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
            disabled={busy === 'figma-connect'}
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
              maxLength={2048}
              placeholder="https://www.figma.com/design/…"
              onChange={(event) => setFileUrl(event.target.value)}
            />
          </label>
          <div className="form-actions form-span">
            <button
              type="button"
              className="primary"
              disabled={!canAdd || !fileUrl.trim() || busy === 'figma-add'}
              onClick={saveFile}
            >
              {busy === 'figma-add' ? 'Reading file…' : 'Add file'}
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
                <span className={`status-dot ${file.syncState}`}>{file.syncState.replace('_', ' ')}</span>
              </div>
              <dl className="repository-facts">
                <div><dt>Pages</dt><dd>{file.metrics.pageCount}</dd></div>
                <div><dt>Frames</dt><dd>{file.metrics.frameCount}</dd></div>
                <div><dt>Components</dt><dd>{file.metrics.componentCount + file.metrics.componentSetCount}</dd></div>
                <div><dt>Comments</dt><dd>{file.metrics.commentCount}</dd></div>
              </dl>
              <p className="fine-print">
                Checked {captureTime(file.lastMetadataCheckAt)} · full checkpoint {captureTime(file.lastFullCaptureAt)} · {file.webhookState === 'active' ? 'webhook and scheduled checks' : 'scheduled checks'}
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
                <p className="fine-print quiet-danger">Metadata check: {file.metadataErrorCode.replaceAll('_', ' ')}</p>
              ) : null}
              {file.metrics.completeness === 'partial' ? (
                <p className="fine-print">Version history is partial; the portal does not present it as a complete count.</p>
              ) : null}
              {file.syncErrorCode ? (
                <p className="fine-print quiet-danger">{file.syncErrorCode.replaceAll('_', ' ')}</p>
              ) : null}
              {integration.canManage ? (
                <div className="repository-actions">
                  <button type="button" className="text-button" disabled={busy === file.id} onClick={() => refresh(file)}>
                    {busy === file.id ? 'Working…' : 'Refresh'}
                  </button>
                  <button type="button" className="text-button quiet-danger" disabled={busy === file.id} onClick={() => setArchiveId(file.id)}>Archive</button>
                </div>
              ) : null}
              {archiveId === file.id ? (
                <div className="archive-confirmation">
                  <label className="field">
                    <span className="field-label">Why are you removing it?</span>
                    <input value={archiveReason} maxLength={180} onChange={(event) => setArchiveReason(event.target.value)} />
                  </label>
                  <div className="button-row">
                    <button type="button" className="secondary compact" onClick={() => { setArchiveId(null); setArchiveReason('') }}>Cancel</button>
                    <button type="button" className="primary compact" disabled={!archiveReason.trim() || busy === file.id} onClick={() => archive(file)}>Archive</button>
                  </div>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
      <ErrorNotice message={error} />
    </section>
  )
}
