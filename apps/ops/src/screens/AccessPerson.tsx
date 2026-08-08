import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router-dom'

import { AccessRoleLabel } from '../components/AccessRoleLabel'
import { AccessSubjectStatus } from '../components/AccessSubjectStatus'
import { PermissionBundleApplication } from '../components/PermissionBundleApplication'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import {
  areaForPermission,
  availablePermissionAreas,
  permissionName,
  readPermissionArea,
  scopeName,
  type PermissionArea,
} from '../lib/permissionLabels'

type Access = NonNullable<FunctionReturnType<typeof api.access.mine>>
type AccessDetail = NonNullable<FunctionReturnType<typeof api.access.detail>>
type PermissionDefinition = AccessDetail['catalog'][number]
type GrantView = AccessDetail['grants'][number]
type GrantScopeType = 'event' | PermissionDefinition['scopes'][number]
export function AccessPerson({ access }: { access: Access }) {
  const { personId } = useParams<{ personId: string }>()
  const detail = useQuery(api.access.detail, personId ? { eventSlug, personId } : 'skip')

  if (!personId) return <p className="notice error">Person ID is missing.</p>
  if (detail === undefined) return <p className="muted">Loading access…</p>
  if (!detail) return <p className="notice error">This account is not visible to your permission scope.</p>

  const canGrant = detail.canGrantAny || detail.grantDelegations.length > 0
  const canAssignRole = access.grants.some(
    (grant) =>
      grant.permissionKey === 'access.roles.assign' &&
      (grant.scopeType === 'event' ||
        (grant.scopeType === 'person' && grant.scopeId === detail.person.id)),
  )
  const canSuspend =
    detail.person.status === 'active' &&
    access.personId !== detail.person.id &&
    hasPersonPermission(access, 'access.subjects.suspend', detail.person.id)
  const canReactivate =
    detail.person.status === 'suspended' &&
    hasPersonPermission(access, 'access.subjects.reactivate', detail.person.id)
  const canUseBundles =
    access.grants.some((grant) => grant.permissionKey === 'access.permission_bundles.read') &&
    access.grants.some((grant) => grant.permissionKey === 'access.permission_bundles.apply')
  const now = Date.now()
  const effectiveGrantCount = detail.grants.filter(
    (grant) =>
      grant.status === 'active' &&
      grant.validFrom <= now &&
      (grant.validUntil === undefined || grant.validUntil > now),
  ).length

  return (
    <section className="access-shell">
      <Link className="back-link" to="/access">← People and permissions</Link>
      <header className="page-heading access-person-heading">
        <div>
          <p className="eyebrow">
            {detail.person.role
              ? roleName(detail.person.role)
              : detail.person.isParticipant
                ? 'Participant'
                : 'No role assigned'}
          </p>
          <h1>{detail.person.displayName}</h1>
          <p className="muted">
            {detail.person.email} · {statusName(detail.person.status)}
            {detail.person.role && detail.person.isParticipant ? ' · Participant' : ''}
          </p>
        </div>
      </header>

      {detail.person.status === 'suspended' ? (
        <p className="notice">Every grant is currently denied by the suspended event-account boundary.</p>
      ) : null}
      {canSuspend || canReactivate ? (
        <AccessSubjectStatus
          key={`${detail.person.id}:${detail.person.status}`}
          accessVersion={detail.accessVersion}
          effectiveGrantCount={effectiveGrantCount}
          personId={detail.person.id}
          status={detail.person.status === 'suspended' ? 'suspended' : 'active'}
        />
      ) : null}
      {canAssignRole && detail.person.status === 'active' ? (
        <AccessRoleLabel
          key={`${detail.person.id}:${detail.person.role ?? 'none'}`}
          accessVersion={detail.accessVersion}
          currentRole={detail.person.role}
          personId={detail.person.id}
        />
      ) : null}
      {canUseBundles && detail.person.status === 'active' ? (
        <PermissionBundleApplication targetPersonId={detail.person.id} />
      ) : null}
      {canGrant && detail.person.status === 'active' ? <GrantForm detail={detail} /> : null}
      <GrantList detail={detail} />
    </section>
  )
}

function GrantForm({ detail }: { detail: AccessDetail }) {
  return detail.canGrantAny
    ? <UnrestrictedGrantForm detail={detail} />
    : <DelegatedGrantForm detail={detail} />
}

function UnrestrictedGrantForm({ detail }: { detail: AccessDetail }) {
  const grant = useMutation(api.access.grant)
  const grantableDefinitions = detail.catalog.filter(
    (definition) => definition.eventWide || definition.scopes.length > 0,
  )
  const firstDefinition = grantableDefinitions.find(
    (definition) => areaForPermission(definition.key) === 'applications',
  ) ?? grantableDefinitions[0]
  const delegableDefinitions = detail.catalog.filter(
    (definition) =>
      !isPermissionAdministrationKey(definition.key) &&
      delegableScopesFor(definition).length > 0,
  )
  const firstDelegableDefinition = delegableDefinitions.find(
    (definition) => areaForPermission(definition.key) === 'applications',
  ) ?? delegableDefinitions[0]
  const [permissionArea, setPermissionArea] = useState<PermissionArea>(
    () => areaForPermission(firstDefinition?.key ?? ''),
  )
  const [permissionKey, setPermissionKey] = useState(firstDefinition?.key ?? '')
  const [scopeType, setScopeType] = useState<GrantScopeType>(() => firstScope(firstDefinition))
  const [scopeId, setScopeId] = useState('')
  const [delegatedPermissionKey, setDelegatedPermissionKey] = useState(firstDelegableDefinition?.key ?? '')
  const [delegatedPermissionArea, setDelegatedPermissionArea] = useState<PermissionArea>(
    () => areaForPermission(firstDelegableDefinition?.key ?? ''),
  )
  const [delegatedScopeType, setDelegatedScopeType] = useState<GrantScopeType>(
    () => firstDelegableDefinition ? delegableScopesFor(firstDelegableDefinition)[0] ?? 'event' : 'event',
  )
  const [delegatedScopeId, setDelegatedScopeId] = useState('')
  const [delegationTargetKind, setDelegationTargetKind] = useState<'any_event_person' | 'exact_email'>('any_event_person')
  const [delegationTargetEmail, setDelegationTargetEmail] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const definition = detail.catalog.find((candidate) => candidate.key === permissionKey)
  const delegationMode = isScopedAuthorityKey(permissionKey)
  const delegatedDefinition = delegableDefinitions.find(
    (candidate) => candidate.key === delegatedPermissionKey,
  )
  const availableScopes = delegationMode
    ? delegatedDefinition ? delegableScopesFor(delegatedDefinition) : []
    : definition ? scopesFor(definition) : []
  const selectedScopeType = delegationMode ? delegatedScopeType : scopeType
  const selectedScopeId = delegationMode ? delegatedScopeId : scopeId
  const selectedResourcePermissionKey = delegationMode
    ? delegatedPermissionKey
    : permissionKey
  const visibleDefinitions = grantableDefinitions.filter(
    (candidate) => areaForPermission(candidate.key) === permissionArea,
  )
  const visibleDelegableDefinitions = delegableDefinitions.filter(
    (candidate) => areaForPermission(candidate.key) === delegatedPermissionArea,
  )
  const options = usePaginatedQuery(
    api.access.scopeOptions,
    selectedScopeType === 'event' || !selectedResourcePermissionKey
      ? 'skip'
      : {
          eventSlug,
          targetPersonId: detail.person.id,
          permissionKey: selectedResourcePermissionKey,
          requestedScopeType: selectedScopeType,
        },
    { initialNumItems: 40 },
  )

  const selectPermission = (key: string) => {
    const nextDefinition = detail.catalog.find((candidate) => candidate.key === key)
    setPermissionKey(key)
    setScopeType(firstScope(nextDefinition))
    setScopeId('')
    setError(null)
  }

  const selectPermissionArea = (value: string) => {
    const area = readPermissionArea(value)
    const nextDefinition = grantableDefinitions.find(
      (candidate) => areaForPermission(candidate.key) === area,
    )
    if (!nextDefinition) return
    setPermissionArea(area)
    selectPermission(nextDefinition.key)
  }

  const selectDelegatedPermission = (key: string) => {
    const nextDefinition = delegableDefinitions.find((candidate) => candidate.key === key)
    setDelegatedPermissionKey(key)
    setDelegatedScopeType(nextDefinition ? delegableScopesFor(nextDefinition)[0] ?? 'event' : 'event')
    setDelegatedScopeId('')
    setError(null)
  }

  const selectDelegatedPermissionArea = (value: string) => {
    const area = readPermissionArea(value)
    const nextDefinition = delegableDefinitions.find(
      (candidate) => areaForPermission(candidate.key) === area,
    )
    if (!nextDefinition) return
    setDelegatedPermissionArea(area)
    selectDelegatedPermission(nextDefinition.key)
  }

  const selectScope = (value: string) => {
    const nextScope = availableScopes.find((candidate) => candidate === value)
    if (!nextScope) return
    if (delegationMode) {
      setDelegatedScopeType(nextScope)
      setDelegatedScopeId('')
    } else {
      setScopeType(nextScope)
      setScopeId('')
    }
  }

  const setSelectedScopeId = (value: string) => {
    if (delegationMode) setDelegatedScopeId(value)
    else setScopeId(value)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (
      !permissionKey ||
      !selectedResourcePermissionKey ||
      (selectedScopeType !== 'event' && !selectedScopeId) ||
      (delegationMode && !validUntil) ||
      (delegationMode && delegationTargetKind === 'exact_email' && !delegationTargetEmail.trim())
    ) return
    setBusy(true)
    setError(null)
    try {
      const expiry = validUntil ? new Date(validUntil).getTime() : undefined
      if (expiry !== undefined && !Number.isFinite(expiry)) throw new Error('Grant expiry is invalid.')
      await grant({
        eventSlug,
        targetPersonId: detail.person.id,
        permissionKey,
        scopeType: delegationMode ? 'event' : selectedScopeType,
        ...(delegationMode || selectedScopeType === 'event' ? {} : { scopeId: selectedScopeId }),
        ...(expiry !== undefined ? { validUntil: expiry } : {}),
        ...(delegationMode
          ? {
              delegation: {
                permissionKey: delegatedPermissionKey,
                scopeType: selectedScopeType,
                ...(selectedScopeType === 'event' ? {} : { scopeId: selectedScopeId }),
                target: delegationTargetKind === 'any_event_person'
                  ? { kind: 'any_event_person' as const }
                  : { kind: 'exact_email' as const, email: delegationTargetEmail },
              },
            }
          : {}),
        expectedAccessVersion: detail.accessVersion,
        reason,
        clientOperationId: crypto.randomUUID(),
      })
      setReason('')
      setValidUntil('')
      setScopeId('')
      setDelegatedScopeId('')
      setDelegationTargetEmail('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!firstDefinition) return null
  return (
    <section className="permission-command">
      <div>
        <h2>Grant one permission</h2>
        <p className="muted">Add one exception to this person's role, team, or assignment access. Choose exactly where it applies.</p>
      </div>
      <form className="grant-form" onSubmit={submit}>
        <label className="field">
          <span>Area</span>
          <select value={permissionArea} onChange={(event) => selectPermissionArea(event.target.value)}>
            {availablePermissionAreas(grantableDefinitions).map((area) => (
              <option key={area.value} value={area.value}>{area.label}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>What they can do</span>
          <select value={permissionKey} onChange={(event) => selectPermission(event.target.value)}>
            {visibleDefinitions.map((candidate) => (
              <option key={candidate.key} value={candidate.key}>{permissionName(candidate.key)}</option>
            ))}
          </select>
        </label>
        {delegationMode ? (
          <>
            <label className="field">
              <span>Delegated area</span>
              <select value={delegatedPermissionArea} onChange={(event) => selectDelegatedPermissionArea(event.target.value)}>
                {availablePermissionAreas(delegableDefinitions).map((area) => (
                  <option key={area.value} value={area.value}>{area.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>What they may {permissionKey === 'access.permissions.grant_scoped' ? 'grant' : 'revoke'}</span>
              <select value={delegatedPermissionKey} onChange={(event) => selectDelegatedPermission(event.target.value)}>
                {visibleDelegableDefinitions.map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>{permissionName(candidate.key)}</option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <label className="field">
          <span>Where it applies</span>
          <select value={selectedScopeType} onChange={(event) => selectScope(event.target.value)}>
            {availableScopes.map((candidate) => (
              <option key={candidate} value={candidate}>{scopeName(candidate, selectedResourcePermissionKey)}</option>
            ))}
          </select>
        </label>
        {selectedScopeType !== 'event' ? (
          <div className="resource-field">
            {options.results.length > 0 ? (
              <label className="field">
                <span>Resource</span>
                <select value={selectedScopeId} onChange={(event) => setSelectedScopeId(event.target.value)}>
                  <option value="">Choose one resource</option>
                  {options.results.map((option) => (
                    <option key={option.id} value={option.id}>{option.label}</option>
                  ))}
                </select>
              </label>
            ) : null}
            {options.status === 'CanLoadMore' ? (
              <button className="secondary resource-more" type="button" onClick={() => options.loadMore(40)}>
                Load more resources
              </button>
            ) : null}
            {options.results.length > 0 ? (
              <details className="configuration-advanced resource-id-advanced">
                <summary>Use an exact resource ID</summary>
                <label className="field">
                  <span>Resource ID</span>
                  <input
                    autoComplete="off"
                    placeholder="Paste an exact resource ID"
                    value={selectedScopeId}
                    onChange={(event) => setSelectedScopeId(event.target.value)}
                  />
                </label>
              </details>
            ) : (
              <label className="field">
                <span>Resource ID</span>
                <input
                  autoComplete="off"
                  placeholder={options.status === 'LoadingFirstPage' ? 'Loading available resources…' : 'Paste an exact resource ID'}
                  value={selectedScopeId}
                  onChange={(event) => setSelectedScopeId(event.target.value)}
                />
              </label>
            )}
          </div>
        ) : null}
        {delegationMode ? (
          <>
            <label className="field">
              <span>Who they may act for</span>
              <select
                value={delegationTargetKind}
                onChange={(event) => setDelegationTargetKind(
                  event.target.value === 'exact_email' ? 'exact_email' : 'any_event_person',
                )}
              >
                <option value="any_event_person">Any active event person</option>
                <option value="exact_email">One exact event email</option>
              </select>
            </label>
            {delegationTargetKind === 'exact_email' ? (
              <label className="field">
                <span>Exact event email</span>
                <input
                  autoComplete="off"
                  inputMode="email"
                  type="email"
                  value={delegationTargetEmail}
                  onChange={(event) => setDelegationTargetEmail(event.target.value)}
                />
              </label>
            ) : null}
          </>
        ) : null}
        <label className="field">
          <span>Until <small>{delegationMode ? 'Required' : 'Optional'} · your local time</small></span>
          <input required={delegationMode} type="datetime-local" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />
        </label>
        <label className="field full-field">
          <span>Why they need this permission</span>
          <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="full-field">
          <button
            className="primary"
            type="submit"
            disabled={
              busy ||
              reason.trim().length < 5 ||
              (selectedScopeType !== 'event' && !selectedScopeId) ||
              (delegationMode && !validUntil) ||
              (delegationMode && delegationTargetKind === 'exact_email' && !delegationTargetEmail.trim())
            }
          >
            {busy ? 'Granting…' : 'Grant permission'}
          </button>
        </div>
      </form>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function DelegatedGrantForm({ detail }: { detail: AccessDetail }) {
  const grant = useMutation(api.access.grant)
  const [ceilingId, setCeilingId] = useState(detail.grantDelegations[0]?.authorityGrantId ?? '')
  const [validUntil, setValidUntil] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ceiling = detail.grantDelegations.find(
    (candidate) => candidate.authorityGrantId === ceilingId,
  )

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ceiling || !validUntil) return
    setBusy(true)
    setError(null)
    try {
      const expiry = new Date(validUntil).getTime()
      if (!Number.isFinite(expiry) || expiry > ceiling.validUntil) {
        throw new Error('The grant must expire on or before the delegation ceiling.')
      }
      await grant({
        eventSlug,
        targetPersonId: detail.person.id,
        permissionKey: ceiling.permissionKey,
        scopeType: ceiling.scopeType,
        ...(ceiling.scopeType === 'event' ? {} : { scopeId: ceiling.scopeId }),
        validUntil: expiry,
        expectedAccessVersion: detail.accessVersion,
        reason,
        clientOperationId: crypto.randomUUID(),
      })
      setValidUntil('')
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!ceiling) return null
  return (
    <section className="permission-command">
      <div>
        <h2>Grant one allowed permission</h2>
        <p className="muted">You can grant only the permission, person, place, and end time shown below.</p>
      </div>
      <form className="grant-form" onSubmit={submit}>
        <label className="field full-field">
          <span>Permission you may grant</span>
          <select value={ceilingId} onChange={(event) => setCeilingId(event.target.value)}>
            {detail.grantDelegations.map((candidate) => (
              <option key={candidate.authorityGrantId} value={candidate.authorityGrantId}>
                {permissionName(candidate.permissionKey)} · {candidate.scopeLabel} · {candidate.targetLabel}
              </option>
            ))}
          </select>
        </label>
        <p className="muted full-field">
          Your authority ends {new Date(ceiling.validUntil).toLocaleString()}.
        </p>
        <label className="field">
          <span>Permission ends <small>Required · your local time</small></span>
          <input required type="datetime-local" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />
        </label>
        <label className="field full-field">
          <span>Why they need this permission</span>
          <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
        </label>
        <div className="full-field">
          <button className="primary" type="submit" disabled={busy || !validUntil || reason.trim().length < 5}>
            {busy ? 'Granting…' : 'Grant permission'}
          </button>
        </div>
      </form>
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}

function GrantList({ detail }: { detail: AccessDetail }) {
  const revoke = useMutation(api.access.revoke)
  const [pendingGrantId, setPendingGrantId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const active = detail.grants.filter(
    (grant) => grant.status === 'active' || grant.status === 'scheduled',
  )
  const direct = active.filter((grant) => isDirectGrant(grant.sourceType))
  const inherited = active.filter((grant) => !isDirectGrant(grant.sourceType))
  const historical = detail.grants.filter(
    (grant) => grant.status !== 'active' && grant.status !== 'scheduled',
  )
  const pendingGrant = active.find((grant) => grant.id === pendingGrantId)

  const confirmRevoke = async () => {
    const grantToRevoke = active.find((grant) => grant.id === pendingGrantId)
    if (!grantToRevoke) return
    setBusy(true)
    setError(null)
    try {
      await revoke({
        eventSlug,
        grantId: grantToRevoke.id,
        expectedAccessVersion: detail.accessVersion,
        reason,
        clientOperationId: crypto.randomUUID(),
      })
      setPendingGrantId(null)
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="grant-list-section">
      <h2>Extra permissions</h2>
      <p className="muted">Permissions added directly to this person, outside their current role, team, or assignment.</p>
      {direct.length > 0 ? (
        <GrantRows grants={direct} onRevoke={(grantId) => {
          setPendingGrantId(grantId)
          setReason('')
        }} />
      ) : <p className="empty">No extra permissions.</p>}

      {inherited.length > 0 ? (
        <details className="grant-source-details">
          <summary>Role, team, and assignment access · {inherited.length}</summary>
          <p className="muted">These permissions follow the source shown on each row.</p>
          <GrantRows grants={inherited} onRevoke={(grantId) => {
            setPendingGrantId(grantId)
            setReason('')
          }} />
        </details>
      ) : null}

      {pendingGrantId ? (
        <div className="revoke-confirmation">
          <p>
            Revoke this exact permission? Other sources for the same permission remain active.
            {pendingGrant && !isDirectGrant(pendingGrant.sourceType)
              ? ` This permission comes from ${sourceName(pendingGrant.sourceType).toLowerCase()}; change that source if the person's broader access should also change.`
              : ''}
            {' '}You may be asked to sign in again.
          </p>
          <label className="field">
            <span>Why this permission is being removed</span>
            <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="button-row">
            <button className="primary" type="button" disabled={busy || reason.trim().length < 5} onClick={() => void confirmRevoke()}>
              {busy ? 'Revoking…' : 'Confirm revoke'}
            </button>
            <button className="secondary" type="button" disabled={busy} onClick={() => setPendingGrantId(null)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}

      {historical.length > 0 ? (
        <details className="grant-history">
          <summary>Previous permissions · {historical.length}</summary>
          <ul>
            {historical.map((grantItem) => (
              <li key={grantItem.id}>
                <span>{permissionName(grantItem.permissionKey)}</span>
                <small>{grantItem.scopeLabel} · {historicalGrantState(grantItem)} · {grantItem.revokeReason ?? grantItem.reason}</small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}

function GrantRows({
  grants,
  onRevoke,
}: {
  grants: GrantView[]
  onRevoke: (grantId: string) => void
}) {
  return (
    <div className="grant-list">
      {grants.map((grantItem) => (
        <article className="grant-row" key={grantItem.id}>
          <div>
            <strong>{permissionName(grantItem.permissionKey)}</strong>
            <span>{scopeName(grantItem.scopeType, grantItem.permissionKey)} · {grantItem.scopeLabel}</span>
            <small>{sourceName(grantItem.sourceType)} · {grantItem.reason}</small>
            <small>{currentGrantWindow(grantItem)}</small>
            {grantItem.delegation ? (
              <small>
                May {grantItem.permissionKey === 'access.permissions.grant_scoped' ? 'grant' : 'revoke'} {permissionName(grantItem.delegation.permissionKey)} · {grantItem.delegation.scopeLabel} · {grantItem.delegation.targetLabel} · until {new Date(grantItem.delegation.validUntil).toLocaleString()}
              </small>
            ) : null}
          </div>
          {grantItem.canRevoke ? (
            <button className="text-button" type="button" onClick={() => onRevoke(grantItem.id)}>Revoke</button>
          ) : null}
        </article>
      ))}
    </div>
  )
}

function currentGrantWindow(grant: GrantView) {
  const start = grant.status === 'scheduled'
    ? `Starts ${new Date(grant.validFrom).toLocaleString()}`
    : grant.activatedAt !== undefined
      ? `Active since ${new Date(grant.activatedAt).toLocaleString()}`
      : 'Active now'
  return grant.validUntil === undefined
    ? start
    : `${start} · expires ${new Date(grant.validUntil).toLocaleString()}`
}

function historicalGrantState(grant: GrantView) {
  if (grant.status === 'expired' && grant.expiredAt !== undefined) {
    return `expired ${new Date(grant.expiredAt).toLocaleString()}`
  }
  if (grant.status === 'revoked' && grant.revokedAt !== undefined) {
    return `revoked ${new Date(grant.revokedAt).toLocaleString()}`
  }
  return grant.status
}

function firstScope(definition: PermissionDefinition | undefined): GrantScopeType {
  if (definition?.eventWide) return 'event'
  return definition?.scopes[0] ?? 'event'
}

function scopesFor(definition: PermissionDefinition): GrantScopeType[] {
  return definition.eventWide ? ['event', ...definition.scopes] : [...definition.scopes]
}

function isScopedAuthorityKey(value: string) {
  return value === 'access.permissions.grant_scoped' || value === 'access.permissions.revoke_scoped'
}

function isPermissionAdministrationKey(value: string) {
  return value === 'access.permissions.grant_any' ||
    value === 'access.permissions.revoke_any' ||
    isScopedAuthorityKey(value)
}

function delegableScopesFor(definition: PermissionDefinition): GrantScopeType[] {
  const scopes = scopesFor(definition)
  return scopes.filter((scope) => {
    if (scope === 'self' || scope === 'page') return false
    if (
      scope === 'scorecard' &&
      (definition.key === 'scorecard.draft.write' ||
        definition.key === 'scorecard.submit' ||
        definition.key === 'scorecard.correction.request')
    ) return false
    return true
  })
}

function sentenceName(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function roleName(value: string) {
  if (value === 'external_judge') return 'External judge'
  if (value === 'sc') return 'SC'
  if (value === 'jc') return 'JC'
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function statusName(value: string) {
  return value === 'active' ? 'Active' : 'Suspended'
}

function isDirectGrant(sourceType: string) {
  return sourceType === 'manual' || sourceType === 'delegated' || sourceType === 'bundle'
}

function sourceName(sourceType: string) {
  const names: Readonly<Record<string, string>> = {
    application_assignment: 'Application assignment',
    bundle: 'Reusable access',
    delegated: 'Delegated permission',
    event_subject: 'Event account',
    manual: 'Direct permission',
    page_assignment: 'Reviewer page',
    panel_assignment: 'Panel assignment',
    participant_membership: 'Participant account',
    production_seed: 'Initial event owner',
    reserve_assignment: 'Reserve assignment',
    role_template: 'Role',
    station_assignment: 'Check-in station',
    team_lead: 'Team lead',
    team_membership: 'Team membership',
  }
  return names[sourceType] ?? sentenceName(sourceType.replaceAll('_', ' '))
}

function hasPersonPermission(access: Access, permissionKey: string, personId: string) {
  return access.grants.some(
    (grant) =>
      grant.permissionKey === permissionKey &&
      (grant.scopeType === 'event' ||
        (grant.scopeType === 'person' && grant.scopeId === personId)),
  )
}
