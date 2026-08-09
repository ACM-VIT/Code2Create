import { api } from '@code2create/backend/api'
import { eventRoleLabels } from '@code2create/domain'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { PermissionBundleMigration } from '../components/PermissionBundleMigration'
import { LoadingLabel, SkeletonCard, SkeletonList, SkeletonStats } from '../components/Skeleton'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import {
  areaForPermission,
  availablePermissionAreas,
  bindingName,
  permissionName,
  readPermissionArea,
  scopeName,
  type PermissionArea,
} from '../lib/permissionLabels'

type Workspace = FunctionReturnType<typeof api.permissionBundles.workspace>
type Bundle = Workspace['bundles'][number]
type BundleId = Bundle['id']
type CatalogEntry = Workspace['catalog'][number]
type DraftEntry = FunctionArgs<typeof api.permissionBundles.saveDraft>['entries'][number]
type ScopeType = DraftEntry['scopeType']
type BundleDetail = FunctionReturnType<typeof api.permissionBundles.detail>

const maximumBundleEntries = 48
const bundleRoles = ['supreme', 'board', 'sc', 'jc', 'external_judge'] as const

export function PermissionBundles() {
  const workspace = useQuery(api.permissionBundles.workspace, { eventSlug })
  const [selectedBundleId, setSelectedBundleId] = useState<BundleId | null>(null)
  const [creating, setCreating] = useState(false)
  const detail = useQuery(
    api.permissionBundles.detail,
    selectedBundleId ? { eventSlug, bundleId: selectedBundleId } : 'skip',
  )

  if (workspace === undefined) {
    return (
      <section className="access-shell">
        <LoadingLabel>Loading the reusable access sets</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonList rows={4} />
      </section>
    )
  }
  const selectedBundle = workspace.bundles.find((bundle) => bundle.id === selectedBundleId)
  const total = workspace.bundles.length
  const unpublished = workspace.bundles.filter((bundle) => bundle.published === undefined).length
  const waitingToPublish = workspace.bundles.filter(
    (bundle) => bundle.published !== undefined && bundle.draft !== undefined,
  ).length
  /** Unfinished sets first: a set nobody can be given is the reason to be here. */
  const ordered = [...workspace.bundles].sort(
    (left, right) => bundleRank(left) - bundleRank(right) || left.label.localeCompare(right.label),
  )

  return (
    <section className="access-shell">
      <Link className="back-link" to="/access">← People and permissions</Link>
      <header className="page-heading">
        <div>
          <h1>Reusable access</h1>
          <p className="muted">
            A saved list of permissions you can give to several people at once.
          </p>
        </div>
        {workspace.canCreate ? (
          <button
            className="secondary"
            type="button"
            onClick={() => {
              setSelectedBundleId(null)
              setCreating(true)
            }}
          >
            New access set
          </button>
        ) : null}
      </header>

      <section className="stage-block">
        <p className="eyebrow">Where these sets stand</p>
        {total === 0 ? (
          <p>
            No access set exists yet, so every permission is granted one person at a time.
          </p>
        ) : unpublished === 0 && waitingToPublish === 0 ? (
          <p>All {total} access {sets(total)} are published and can be given out.</p>
        ) : (
          <>
            {unpublished > 0 ? (
              <p>
                {unpublished} of {total} access {sets(total)}{' '}
                {unpublished === 1 ? 'has' : 'have'} never been published, so nobody can be
                given {unpublished === 1 ? 'it' : 'them'} yet.
              </p>
            ) : null}
            {waitingToPublish > 0 ? (
              <p>
                {waitingToPublish} published {sets(waitingToPublish)}{' '}
                {waitingToPublish === 1 ? 'has' : 'have'} unpublished edits, so holders keep
                the older permissions.
              </p>
            ) : null}
          </>
        )}
        {!workspace.canCreate ? (
          <p className="muted">You can read these sets but not create or publish one.</p>
        ) : null}
      </section>

      {total > 0 ? (
        <dl className="catalog-summary">
          <div>
            <dt>Never published</dt>
            <dd>{unpublished}</dd>
          </div>
          <div>
            <dt>Draft waiting</dt>
            <dd>{waitingToPublish}</dd>
          </div>
          <div>
            <dt>Ready to give out</dt>
            <dd>{total - unpublished}</dd>
          </div>
        </dl>
      ) : null}

      <div className="bundle-list">
        {ordered.map((bundle) => (
          <button
            className={`bundle-row${bundle.id === selectedBundleId ? ' selected' : ''}`}
            key={bundle.id}
            type="button"
            onClick={() => {
              setCreating(false)
              setSelectedBundleId(bundle.id)
            }}
          >
            <span>
              <strong>{bundle.label}</strong>
              <small>{bundleStatement(bundle)}</small>
            </span>
            <span className="bundle-row-state">
              {bundle.published?.publishedAt === undefined
                ? 'Never published'
                : `Published ${dateOnly(bundle.published.publishedAt)}`}
            </span>
          </button>
        ))}
      </div>

      {creating ? (
        <BundleEditor
          key="new-bundle"
          canEdit={workspace.canCreate}
          canMigrate={false}
          catalog={workspace.catalog}
          detail={null}
          onSaved={(bundleId) => {
            setCreating(false)
            setSelectedBundleId(bundleId)
          }}
        />
      ) : null}
      {selectedBundleId && detail === undefined ? (
        <>
          <LoadingLabel>Loading this access set</LoadingLabel>
          <SkeletonCard lines={5} />
        </>
      ) : null}
      {selectedBundle && detail ? (
        <BundleEditor
          key={`${detail.bundle.id}:${detail.bundle.version}:${detail.draft?.revision ?? 0}`}
          canEdit={selectedBundle.canEdit}
          canMigrate={selectedBundle.canMigrate}
          catalog={workspace.catalog}
          detail={detail}
          onSaved={setSelectedBundleId}
        />
      ) : null}
    </section>
  )
}

function BundleEditor({
  canEdit,
  canMigrate,
  catalog,
  detail,
  onSaved,
}: {
  canEdit: boolean
  canMigrate: boolean
  catalog: CatalogEntry[]
  detail: BundleDetail | null
  onSaved: (bundleId: BundleId) => void
}) {
  const saveDraft = useMutation(api.permissionBundles.saveDraft)
  const publish = useMutation(api.permissionBundles.publish)
  const source = detail?.draft ?? detail?.published
  const [key, setKey] = useState(detail?.bundle.key ?? '')
  const [label, setLabel] = useState(source?.label ?? detail?.bundle.label ?? '')
  const [defaultRole, setDefaultRole] = useState(source?.defaultRole ?? '')
  const [entries, setEntries] = useState<DraftEntry[]>(
    source?.entries ?? firstEntries(catalog),
  )
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const diff = useMemo(
    () => entryDiff(detail?.published?.entries ?? [], entries),
    [detail?.published?.entries, entries],
  )

  const submitDraft = async (event: FormEvent) => {
    event.preventDefault()
    if (!canEdit) return
    setMessage(null)
    if (label.trim().length < 2 || key.length < 2) {
      setError('Give this set a name of at least two characters.')
      return
    }
    if (entries.length === 0) {
      setError('Add at least one permission.')
      return
    }
    if (reason.trim().length < 5) {
      setError('Say why this set is changing, in at least five characters.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const result = await saveDraft({
        eventSlug,
        bundleId: detail?.bundle.id ?? null,
        key,
        label,
        defaultRole: roleValue(defaultRole),
        entries,
        expectedBundleVersion: detail?.bundle.version ?? 0,
        expectedDraftRevision: detail?.draft?.revision ?? null,
        reason,
        clientOperationId: crypto.randomUUID(),
      })
      setReason('')
      setMessage('Draft saved. Nobody receives these permissions until it is published.')
      onSaved(result.bundleId)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setSaving(false)
    }
  }

  const publishDraft = async () => {
    if (!canEdit || !detail?.draft) return
    setMessage(null)
    if (reason.trim().length < 5) {
      setError('Say why this set is being published, in at least five characters.')
      return
    }
    setPublishing(true)
    setError(null)
    try {
      await publish({
        eventSlug,
        bundleId: detail.bundle.id,
        expectedBundleVersion: detail.bundle.version,
        expectedDraftRevision: detail.draft.revision,
        reason,
        clientOperationId: crypto.randomUUID(),
      })
      setConfirmPublish(false)
      setReason('')
      setMessage('This access set is published, so it can now be given to people.')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setPublishing(false)
    }
  }

  return (
    <section className="bundle-editor">
      <div>
        <h2>{detail ? detail.bundle.label : 'New access set'}</h2>
        <p className="muted">Every line below is granted when a person receives this set.</p>
      </div>

      <form className="bundle-form" onSubmit={(event) => void submitDraft(event)}>
        <div className="bundle-meta-fields">
          <label className="field">
            <span>Name</span>
            <input
              disabled={!canEdit}
              placeholder="Check-in staff"
              value={label}
              onChange={(event) => {
                const nextLabel = event.target.value
                setLabel(nextLabel)
                if (detail === null) setKey(bundleKey(nextLabel))
              }}
            />
          </label>
          <label className="field">
            <span>Role label <small>Optional · does not grant access</small></span>
            <select
              disabled={!canEdit}
              value={defaultRole}
              onChange={(event) => setDefaultRole(event.target.value)}
            >
              <option value="">None</option>
              {bundleRoles.map((role) => (
                <option key={role} value={role}>{eventRoleLabels[role]}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="bundle-entry-list">
          {entries.map((entry, index) => (
            <BundleEntryRow
              canEdit={canEdit}
              catalog={catalog}
              entry={entry}
              index={index}
              key={`${index}:${entry.permissionKey}:${entry.scopeType}:${entry.scopeSource}`}
              onChange={(next) =>
                setEntries((current) =>
                  current.map((candidate, candidateIndex) =>
                    candidateIndex === index ? next : candidate,
                  ),
                )
              }
              onRemove={() =>
                setEntries((current) =>
                  current.filter((_, candidateIndex) => candidateIndex !== index),
                )
              }
            />
          ))}
        </div>
        {canEdit && entries.length < maximumBundleEntries ? (
          <button
            className="text-button"
            type="button"
            onClick={() => {
              const next = defaultEntry(firstCatalogEntry(catalog))
              if (next) setEntries((current) => [...current, next])
            }}
          >
            Add permission
          </button>
        ) : null}
        {canEdit && entries.length >= maximumBundleEntries ? (
          <p className="muted">
            A set holds at most {maximumBundleEntries} permissions. Remove one to add another.
          </p>
        ) : null}

        <p className="muted">
          {detail?.published
            ? `Against the published version, this draft adds ${diff.added}, removes ${diff.removed}, and leaves ${diff.unchanged} unchanged.`
            : `Publishing hands out ${entries.length} ${permissions(entries.length)} to everyone who receives it.`}
        </p>

        {canEdit ? (
          <>
            <label className="field bundle-reason">
              <span>Why this changed</span>
              <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
            </label>
            <div className="button-row">
              <button className="primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Save draft'}
              </button>
              {detail?.draft ? (
                <button
                  className="secondary"
                  type="button"
                  disabled={saving || publishing}
                  onClick={() => setConfirmPublish(true)}
                >
                  Review publication
                </button>
              ) : null}
            </div>
          </>
        ) : (
          <p className="notice">You can read this set, but cannot publish changes to it.</p>
        )}
      </form>

      {confirmPublish && detail?.draft ? (
        <div className="publish-confirmation">
          <h2>Make this access set available?</h2>
          <p>
            It will carry {detail.draft.entries.length} {permissions(detail.draft.entries.length)}.
            People who already hold it keep their current permissions until you move them across.
          </p>
          <div className="button-row">
            <button
              className="primary"
              type="button"
              disabled={publishing}
              onClick={() => void publishDraft()}
            >
              {publishing ? 'Publishing…' : 'Confirm publish'}
            </button>
            <button className="secondary" type="button" disabled={publishing} onClick={() => setConfirmPublish(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
      {detail?.published && canMigrate ? (
        <PermissionBundleMigration bundleId={detail.bundle.id} />
      ) : null}
    </section>
  )
}

function BundleEntryRow({
  canEdit,
  catalog,
  entry,
  index,
  onChange,
  onRemove,
}: {
  canEdit: boolean
  catalog: CatalogEntry[]
  entry: DraftEntry
  index: number
  onChange: (entry: DraftEntry) => void
  onRemove: () => void
}) {
  const definition = catalog.find((candidate) => candidate.key === entry.permissionKey)
  const permissionArea = areaForPermission(entry.permissionKey)
  const visibleDefinitions = catalog.filter(
    (candidate) => areaForPermission(candidate.key) === permissionArea,
  )
  const scopes = definition ? scopesFor(definition) : []
  const selectPermission = (value: string) => {
    const next = defaultEntry(catalog.find((candidate) => candidate.key === value))
    if (next) onChange(next)
  }
  const selectScope = (value: string) => {
    const nextScope = scopes.find((candidate) => candidate === value)
    if (!nextScope) return
    onChange(entryForScope(entry.permissionKey, nextScope))
  }
  const selectArea = (value: string) => {
    const area = readPermissionArea(value)
    const next = defaultEntry(catalog.find((candidate) => areaForPermission(candidate.key) === area))
    if (next) onChange(next)
  }
  const selectSource = (value: string) => {
    if (entry.scopeType !== 'person') return
    const source = (['target', 'binding'] as const).find((candidate) => candidate === value)
    if (!source) return
    onChange({
      permissionKey: entry.permissionKey,
      scopeType: 'person',
      scopeSource: source,
      ...(source === 'binding' ? { bindingKey: entry.bindingKey ?? 'person' } : {}),
      validityRule: 'bundle',
    })
  }

  return (
    <div className="bundle-entry-row">
      <span className="bundle-entry-number">{index + 1}</span>
      <label className="field">
        <span>Area</span>
        <select disabled={!canEdit} value={permissionArea} onChange={(event) => selectArea(event.target.value)}>
          {availablePermissionAreas(catalog).map((area: { value: PermissionArea; label: string }) => (
            <option key={area.value} value={area.value}>{area.label}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>What they can do</span>
        <select disabled={!canEdit} value={entry.permissionKey} onChange={(event) => selectPermission(event.target.value)}>
          {visibleDefinitions.map((candidate) => (
            <option key={candidate.key} value={candidate.key}>{permissionName(candidate.key)}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Where it applies</span>
        <select disabled={!canEdit} value={entry.scopeType} onChange={(event) => selectScope(event.target.value)}>
          {scopes.map((candidate) => (
            <option key={candidate} value={candidate}>{scopeName(candidate, entry.permissionKey)}</option>
          ))}
        </select>
      </label>
      {entry.scopeType === 'person' ? (
        <label className="field">
          <span>Person</span>
          <select disabled={!canEdit} value={entry.scopeSource} onChange={(event) => selectSource(event.target.value)}>
            <option value="target">The person receiving this set</option>
            <option value="binding">Choose when assigning</option>
          </select>
        </label>
      ) : null}
      {entry.scopeSource === 'binding' ? (
        <details className="configuration-advanced bundle-binding-name">
          <summary>Advanced selection name</summary>
          <label className="field">
            <span>{bindingName(entry.bindingKey ?? 'resource')}</span>
            <input
              aria-label="Internal selection name"
              disabled={!canEdit}
              value={entry.bindingKey ?? ''}
              onChange={(event) =>
                onChange({
                  ...entry,
                  bindingKey: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''),
                })
              }
            />
          </label>
        </details>
      ) : null}
      {canEdit ? (
        <button className="text-button bundle-remove" type="button" onClick={onRemove}>
          Remove
        </button>
      ) : null}
    </div>
  )
}

/** A set nobody can be given ranks above one that is merely out of date. */
function bundleRank(bundle: Bundle) {
  if (bundle.published === undefined) return 0
  if (bundle.draft !== undefined) return 1
  return 2
}

function bundleStatement(bundle: Bundle) {
  if (bundle.published === undefined) {
    const drafted = bundle.draft?.entryCount ?? 0
    return `Not published. The draft holds ${drafted} ${permissions(drafted)}.`
  }
  if (bundle.draft !== undefined) {
    return `In use with ${bundle.published.entryCount} ${permissions(bundle.published.entryCount)}. A draft of ${bundle.draft.entryCount} is waiting to be published.`
  }
  return `Ready to give to anyone, carrying ${bundle.published.entryCount} ${permissions(bundle.published.entryCount)}.`
}

function permissions(count: number) {
  return count === 1 ? 'permission' : 'permissions'
}

function sets(count: number) {
  return count === 1 ? 'set' : 'sets'
}

function dateOnly(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(timestamp)
}

function firstEntries(catalog: CatalogEntry[]) {
  const entry = defaultEntry(firstCatalogEntry(catalog))
  return entry ? [entry] : []
}

function firstCatalogEntry(catalog: CatalogEntry[]) {
  return catalog.find((entry) => areaForPermission(entry.key) === 'applications') ?? catalog[0]
}

function defaultEntry(definition: CatalogEntry | undefined): DraftEntry | null {
  if (!definition) return null
  const scope = definition.eventWide ? 'event' : definition.scopes[0]
  return scope ? entryForScope(definition.key, scope) : null
}

function entryForScope(permissionKey: string, scopeType: ScopeType): DraftEntry {
  if (scopeType === 'event') {
    return { permissionKey, scopeType, scopeSource: 'event', validityRule: 'bundle' }
  }
  if (scopeType === 'self' || scopeType === 'person') {
    return { permissionKey, scopeType, scopeSource: 'target', validityRule: 'bundle' }
  }
  return {
    permissionKey,
    scopeType,
    scopeSource: 'binding',
    bindingKey: scopeType.replaceAll('-', '_'),
    validityRule: 'bundle',
  }
}

function scopesFor(definition: CatalogEntry): ScopeType[] {
  return definition.eventWide ? ['event', ...definition.scopes] : [...definition.scopes]
}

function roleValue(value: string): FunctionArgs<typeof api.permissionBundles.saveDraft>['defaultRole'] {
  return bundleRoles.find((role) => role === value) ?? null
}

function entryIdentity(entry: DraftEntry) {
  return `${entry.permissionKey}|${entry.scopeType}|${entry.scopeSource}|${entry.bindingKey ?? ''}`
}

function entryDiff(previous: DraftEntry[], next: DraftEntry[]) {
  const previousIds = new Set(previous.map(entryIdentity))
  const nextIds = new Set(next.map(entryIdentity))
  return {
    added: [...nextIds].filter((id) => !previousIds.has(id)).length,
    removed: [...previousIds].filter((id) => !nextIds.has(id)).length,
    unchanged: [...nextIds].filter((id) => previousIds.has(id)).length,
  }
}

function bundleKey(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
}
