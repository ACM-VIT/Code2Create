import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery } from 'convex/react'
import { useMemo, useState, type FormEvent } from 'react'

import { AccessManagementDisclosure } from './AccessManagementDisclosure'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import { grantSourceName, permissionName, scopeName } from '../lib/permissionLabels'

type AccessDetail = NonNullable<FunctionReturnType<typeof api.access.detail>>
type PermissionDefinition = AccessDetail['catalog'][number]
type DelegationCeiling = AccessDetail['grantDelegations'][number]
type GrantView = FunctionReturnType<typeof api.access.grantLedger>['page'][number]
type GrantScopeType = 'event' | PermissionDefinition['scopes'][number]

type BatchGrantDraft = {
  id: string
  permissionKey: string
  scopeType: GrantScopeType
  scopeId: string
  authorityGrantId?: string
}

type BatchMode = 'add' | 'remove' | null

const maximumBatchSize = 20

export function PermissionBatchControl({ detail }: { detail: AccessDetail }) {
  const [mode, setMode] = useState<BatchMode>(null)
  const canAdministerRemovals = detail.canRevokeAny || detail.revokeDelegations.length > 0
  const active = usePaginatedQuery(
    api.access.grantLedger,
    canAdministerRemovals
      ? { eventSlug, personId: detail.person.id, status: 'active' }
      : 'skip',
    { initialNumItems: 40 },
  )
  const scheduled = usePaginatedQuery(
    api.access.grantLedger,
    canAdministerRemovals
      ? { eventSlug, personId: detail.person.id, status: 'scheduled' }
      : 'skip',
    { initialNumItems: 40 },
  )
  const grantableDefinitions = useMemo(
    () => detail.catalog.filter((definition) => (
      !isScopedAuthorityKey(definition.key) &&
      (detail.canGrantAny || detail.grantDelegations.some(
        (ceiling) => ceiling.permissionKey === definition.key,
      ))
    )),
    [detail.canGrantAny, detail.catalog, detail.grantDelegations],
  )
  const removable = [...active.results, ...scheduled.results].filter(
    (grant) => grant.canRevoke && (grant.status === 'active' || grant.status === 'scheduled'),
  )
  const canLoadMore = active.status === 'CanLoadMore' || scheduled.status === 'CanLoadMore'
  const delegatedExactScopes = new Set(detail.grantDelegations.map((ceiling) => JSON.stringify([
    ceiling.permissionKey,
    ceiling.scopeType,
    ceiling.scopeId ?? null,
  ]))).size
  const canAdd = detail.canGrantAny
    ? grantableDefinitions.length > 0
    : delegatedExactScopes > 1
  const canRemove = removable.length > 1 || (canAdministerRemovals && canLoadMore)

  if (!canAdd && !canRemove) return null

  return (
    <AccessManagementDisclosure
      description="Add or remove several exact permissions in one audited change."
      title="Change several permissions"
    >
      <section className="permission-batch-control">
        {mode === null ? (
          <div className="button-row permission-batch-actions">
            {canAdd ? (
              <button className="secondary" type="button" onClick={() => setMode('add')}>
                Add several
              </button>
            ) : null}
            {canRemove ? (
              <button className="secondary" type="button" onClick={() => setMode('remove')}>
                Remove several
              </button>
            ) : null}
          </div>
        ) : null}

      {mode === 'add' ? (
        <BatchGrantForm
          definitions={grantableDefinitions}
          detail={detail}
          onDone={() => setMode(null)}
        />
      ) : null}
      {mode === 'remove' ? (
        <BatchRevokeForm
          canLoadMore={canLoadMore}
          detail={detail}
          grants={removable}
          onDone={() => setMode(null)}
          onLoadMore={() => {
            if (active.status === 'CanLoadMore') active.loadMore(40)
            if (scheduled.status === 'CanLoadMore') scheduled.loadMore(40)
          }}
        />
      ) : null}
      </section>
    </AccessManagementDisclosure>
  )
}

function BatchGrantForm({
  definitions,
  detail,
  onDone,
}: {
  definitions: PermissionDefinition[]
  detail: AccessDetail
  onDone: () => void
}) {
  const firstDefinition = requireFirstDefinition(definitions)
  const grantBatch = useMutation(api.access.grantBatch)
  const operations = useOperationRunner()
  const [drafts, setDrafts] = useState<BatchGrantDraft[]>(() => [
    draftForDefinition(detail, firstDefinition),
  ])
  const [validUntil, setValidUntil] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = operations.hasPending('permission-grant-batch')
  const selectedCeilings = drafts.map((draft) => selectedCeiling(detail, draft))
  const expiry = validUntil ? new Date(validUntil).getTime() : undefined
  const exactScopes = drafts.map(exactDraftScope)
  const repeatsScope = new Set(exactScopes).size !== exactScopes.length
  const expiryValid = expiry === undefined
    ? detail.canGrantAny
    : Number.isFinite(expiry) &&
      expiry > Date.now() &&
      selectedCeilings.every((ceiling) => ceiling === undefined || expiry <= ceiling.validUntil)
  const ready = drafts.length >= 2 &&
    reason.trim().length >= 5 &&
    !repeatsScope &&
    expiryValid &&
    drafts.every((draft) => draft.scopeType === 'event' || draft.scopeId.length > 0) &&
    (detail.canGrantAny || selectedCeilings.every((ceiling) => ceiling !== undefined))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!pending && !ready) return
    setBusy(true)
    setError(null)
    try {
      await operations.run('permission-grant-batch', (clientOperationId) => {
        const command = {
          eventSlug,
          targetPersonId: detail.person.id,
          grants: drafts.map((draft) => ({
            permissionKey: draft.permissionKey,
            scopeType: draft.scopeType,
            ...(draft.scopeType === 'event' ? {} : { scopeId: draft.scopeId }),
          })),
          ...(expiry !== undefined ? { validUntil: expiry } : {}),
          expectedAccessVersion: detail.accessVersion,
          reason,
          clientOperationId,
        }
        return () => grantBatch(command)
      })
      onDone()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="permission-batch-form" onSubmit={submit}>
      <fieldset disabled={busy || pending} style={{ display: 'contents' }}>
        <div className="permission-batch-rows">
          {drafts.map((draft) => (
            <BatchGrantRow
              definitions={definitions}
              detail={detail}
              draft={draft}
              key={draft.id}
              removable={drafts.length > 1}
              onChange={(next) => setDrafts((current) => current.map(
                (candidate) => candidate.id === next.id ? next : candidate,
              ))}
              onRemove={() => setDrafts((current) => current.filter(
                (candidate) => candidate.id !== draft.id,
              ))}
            />
          ))}
        </div>
        <button
          className="text-button permission-batch-add-row"
          disabled={drafts.length >= maximumBatchSize}
          type="button"
          onClick={() => setDrafts((current) => [
            ...current,
            draftForDefinition(detail, firstDefinition),
          ])}
        >
          + Add permission
        </button>
        <label className="field permission-batch-expiry">
          <span>Ends <small>{detail.canGrantAny ? 'Optional' : 'Required'} · your local time</small></span>
          <input
            required={!detail.canGrantAny}
            type="datetime-local"
            value={validUntil}
            onChange={(event) => setValidUntil(event.target.value)}
          />
        </label>
        <label className="field permission-batch-reason">
          <span>Why they need these permissions</span>
          <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
      </fieldset>
      {repeatsScope ? (
        <p className="notice error" role="alert">One exact permission appears more than once.</p>
      ) : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
      <div className="button-row">
        <button className="primary" disabled={busy || (!pending && !ready)} type="submit">
          {busy ? 'Adding…' : pending ? 'Confirm earlier change' : 'Add selected permissions'}
        </button>
        <button className="secondary" disabled={busy || pending} type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function BatchGrantRow({
  definitions,
  detail,
  draft,
  onChange,
  onRemove,
  removable,
}: {
  definitions: PermissionDefinition[]
  detail: AccessDetail
  draft: BatchGrantDraft
  onChange: (draft: BatchGrantDraft) => void
  onRemove: () => void
  removable: boolean
}) {
  const definition = requireDefinition(definitions, draft.permissionKey)
  const ceilings = ceilingsFor(detail, definition.key)
  const ceiling = selectedCeiling(detail, draft)
  const scopes = scopesFor(definition)
  const needsResource = detail.canGrantAny && draft.scopeType !== 'event'
  const options = usePaginatedQuery(
    api.access.scopeOptions,
    needsResource
      ? {
          eventSlug,
          targetPersonId: detail.person.id,
          permissionKey: draft.permissionKey,
          requestedScopeType: draft.scopeType,
        }
      : 'skip',
    { initialNumItems: 40 },
  )

  return (
    <div className="permission-batch-row">
      <label className="field">
        <span>Permission</span>
        <select
          value={draft.permissionKey}
          onChange={(event) => {
            const next = definitions.find((candidate) => candidate.key === event.target.value)
            if (next) onChange(draftForDefinition(detail, next, draft.id))
          }}
        >
          {definitions.map((candidate) => (
            <option key={candidate.key} value={candidate.key}>{candidate.label}</option>
          ))}
        </select>
      </label>

      {!detail.canGrantAny && ceilings.length > 1 ? (
        <label className="field">
          <span>Where it applies</span>
          <select
            value={ceiling?.authorityGrantId ?? ''}
            onChange={(event) => {
              const next = ceilings.find(
                (candidate) => candidate.authorityGrantId === event.target.value,
              )
              if (next) onChange(draftForCeiling(draft.id, definition, next))
            }}
          >
            {ceilings.map((candidate) => (
              <option key={candidate.authorityGrantId} value={candidate.authorityGrantId}>
                {candidate.scopeLabel} · until {new Date(candidate.validUntil).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
      ) : detail.canGrantAny && scopes.length > 1 ? (
        <label className="field">
          <span>Where it applies</span>
          <select
            value={draft.scopeType}
            onChange={(event) => {
              const next = scopes.find((candidate) => candidate === event.target.value)
              if (next) onChange({ ...draft, scopeType: next, scopeId: '' })
            }}
          >
            {scopes.map((scope) => (
              <option key={scope} value={scope}>{scopeName(scope, draft.permissionKey)}</option>
            ))}
          </select>
        </label>
      ) : (
        <div className="field permission-batch-fixed-scope">
          <span>Where it applies</span>
          <p>{ceiling?.scopeLabel ?? scopeName(draft.scopeType, draft.permissionKey)}</p>
        </div>
      )}

      {needsResource ? (
        options.status === 'LoadingFirstPage' ? (
          <div className="field permission-batch-resource">
            <span>{scopeName(draft.scopeType, draft.permissionKey)}</span>
            <p className="muted">Finding choices…</p>
          </div>
        ) : options.results.length > 0 ? (
          <label className="field permission-batch-resource">
            <span>{scopeName(draft.scopeType, draft.permissionKey)}</span>
            <select
              value={draft.scopeId}
              onChange={(event) => onChange({ ...draft, scopeId: event.target.value })}
            >
              <option value="">Choose one</option>
              {options.results.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </label>
        ) : (
          <div className="field permission-batch-resource">
            <span>{scopeName(draft.scopeType, draft.permissionKey)}</span>
            <p className="muted">Nothing is available.</p>
          </div>
        )
      ) : null}

      <div className="permission-batch-row-actions">
        {needsResource && options.status === 'CanLoadMore' ? (
          <button className="text-button" type="button" onClick={() => options.loadMore(40)}>
            Show more
          </button>
        ) : null}
        {removable ? (
          <button className="text-button" type="button" onClick={onRemove}>Remove</button>
        ) : null}
      </div>
    </div>
  )
}

function BatchRevokeForm({
  canLoadMore,
  detail,
  grants,
  onDone,
  onLoadMore,
}: {
  canLoadMore: boolean
  detail: AccessDetail
  grants: GrantView[]
  onDone: () => void
  onLoadMore: () => void
}) {
  const revokeBatch = useMutation(api.access.revokeBatch)
  const operations = useOperationRunner()
  const [selected, setSelected] = useState<GrantView['id'][]>([])
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = operations.hasPending('permission-revoke-batch')
  const selectedGrants = grants.filter((grant) => selected.includes(grant.id))
  const ready = selectedGrants.length >= 2 && reason.trim().length >= 5

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!pending && !ready) return
    setBusy(true)
    setError(null)
    try {
      await operations.run('permission-revoke-batch', (clientOperationId) => {
        const command = {
          eventSlug,
          targetPersonId: detail.person.id,
          grantIds: selectedGrants.map((grant) => grant.id),
          expectedAccessVersion: detail.accessVersion,
          reason,
          clientOperationId,
        }
        return () => revokeBatch(command)
      })
      onDone()
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="permission-batch-form" onSubmit={submit}>
      <fieldset disabled={busy || pending} style={{ display: 'contents' }}>
        <div className="permission-batch-selection">
          {grants.map((grant) => {
            const checked = selected.includes(grant.id)
            return (
              <label key={grant.id}>
                <input
                  checked={checked}
                  disabled={!checked && selected.length >= maximumBatchSize}
                  type="checkbox"
                  onChange={() => setSelected((current) => (
                    current.includes(grant.id)
                      ? current.filter((id) => id !== grant.id)
                      : current.length < maximumBatchSize
                        ? [...current, grant.id]
                        : current
                  ))}
                />
                <span>
                  <strong>{permissionName(grant.permissionKey)}</strong>
                  <small>{grant.scopeLabel} · {grantSourceName(grant.sourceType)}</small>
                </span>
              </label>
            )
          })}
        </div>
        {canLoadMore ? (
          <button className="text-button permission-batch-add-row" type="button" onClick={onLoadMore}>
            Load more current permissions
          </button>
        ) : null}
        <label className="field permission-batch-reason">
          <span>Why these permissions are being removed</span>
          <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
      </fieldset>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
      <div className="button-row">
        <button className="primary" disabled={busy || (!pending && !ready)} type="submit">
          {busy ? 'Removing…' : pending ? 'Confirm earlier change' : 'Remove selected permissions'}
        </button>
        <button className="secondary" disabled={busy || pending} type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function draftForDefinition(
  detail: AccessDetail,
  definition: PermissionDefinition,
  id: string = crypto.randomUUID(),
): BatchGrantDraft {
  if (!detail.canGrantAny) {
    const ceiling = ceilingsFor(detail, definition.key)[0]
    if (!ceiling) throw new Error('A delegated batch permission has no matching authority ceiling.')
    return draftForCeiling(id, definition, ceiling)
  }
  const scopeType = scopesFor(definition)[0]
  if (!scopeType) throw new Error('A permission in the catalog has no usable scope.')
  return { id, permissionKey: definition.key, scopeType, scopeId: '' }
}

function draftForCeiling(
  id: string,
  definition: PermissionDefinition,
  ceiling: DelegationCeiling,
): BatchGrantDraft {
  return {
    id,
    permissionKey: definition.key,
    scopeType: ceiling.scopeType,
    scopeId: ceiling.scopeId ?? '',
    authorityGrantId: ceiling.authorityGrantId,
  }
}

function selectedCeiling(detail: AccessDetail, draft: BatchGrantDraft) {
  if (detail.canGrantAny || draft.authorityGrantId === undefined) return undefined
  return detail.grantDelegations.find(
    (ceiling) => ceiling.authorityGrantId === draft.authorityGrantId,
  )
}

function ceilingsFor(detail: AccessDetail, permissionKey: string) {
  return detail.grantDelegations.filter((ceiling) => ceiling.permissionKey === permissionKey)
}

function scopesFor(definition: PermissionDefinition): GrantScopeType[] {
  return definition.eventWide ? ['event', ...definition.scopes] : [...definition.scopes]
}

function exactDraftScope(draft: BatchGrantDraft) {
  return JSON.stringify([
    draft.permissionKey,
    draft.scopeType,
    draft.scopeType === 'event' ? null : draft.scopeId,
  ])
}

function isScopedAuthorityKey(value: string) {
  return value === 'access.permissions.grant_scoped' || value === 'access.permissions.revoke_scoped'
}

function requireFirstDefinition(definitions: PermissionDefinition[]) {
  const definition = definitions[0]
  if (!definition) throw new Error('Batch permission editing needs a grantable permission.')
  return definition
}

function requireDefinition(definitions: PermissionDefinition[], permissionKey: string) {
  const definition = definitions.find((candidate) => candidate.key === permissionKey)
  if (!definition) throw new Error('A selected batch permission is no longer in the catalog.')
  return definition
}
