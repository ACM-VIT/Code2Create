import { api } from '@code2create/backend/api'
import type { FunctionArgs, FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { useState, type FormEvent } from 'react'

import { BundleBindingField } from './BundleBindingField'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { permissionName, scopeName } from '../lib/permissionLabels'

type TargetPersonId = FunctionArgs<typeof api.permissionBundles.applicableToTarget>['targetPersonId']
type Applicable = FunctionReturnType<typeof api.permissionBundles.applicableToTarget>[number]
type VersionId = Applicable['versionId']
type PreviewRequest = {
  bundleVersionId: VersionId
  bindings: { key: string; scopeId: string }[]
  validUntil?: number
}

export function PermissionBundleApplication({
  targetPersonId,
}: {
  targetPersonId: TargetPersonId
}) {
  const applicable = useQuery(api.permissionBundles.applicableToTarget, {
    eventSlug,
    targetPersonId,
  })
  const applyBundle = useMutation(api.permissionBundles.apply)
  const [selectedVersionId, setSelectedVersionId] = useState<VersionId | null>(null)
  const [bindingValues, setBindingValues] = useState<Record<string, string>>({})
  const [validUntil, setValidUntil] = useState('')
  const [reason, setReason] = useState('')
  const [previewRequest, setPreviewRequest] = useState<PreviewRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const selected = applicable?.find((bundle) => bundle.versionId === selectedVersionId)
  const preview = useQuery(
    api.permissionBundles.previewApplication,
    previewRequest
      ? {
          eventSlug,
          targetPersonId,
          bundleVersionId: previewRequest.bundleVersionId,
          bindings: previewRequest.bindings,
          ...(previewRequest.validUntil !== undefined
            ? { validUntil: previewRequest.validUntil }
            : {}),
        }
      : 'skip',
  )

  if (applicable === undefined) return <p className="muted">Checking applicable bundles…</p>
  if (applicable.length === 0) return null

  const chooseBundle = (value: string) => {
    const versionId = applicable.find((bundle) => bundle.versionId === value)?.versionId ?? null
    setSelectedVersionId(versionId)
    setBindingValues({})
    setPreviewRequest(null)
    setMessage(null)
    setError(null)
  }

  const requestPreview = (event: FormEvent) => {
    event.preventDefault()
    if (!selected) return
    const bindings = selected.bindings.map((binding) => ({
      key: binding.key,
      scopeId: bindingValues[binding.key] ?? '',
    }))
    if (bindings.some((binding) => !binding.scopeId)) return
    const expiry = validUntil ? new Date(validUntil).getTime() : undefined
    if (expiry !== undefined && !Number.isFinite(expiry)) {
      setError('Grant expiry is invalid.')
      return
    }
    setError(null)
    setMessage(null)
    setPreviewRequest({
      bundleVersionId: selected.versionId,
      bindings,
      ...(expiry !== undefined ? { validUntil: expiry } : {}),
    })
  }

  const apply = async () => {
    if (!preview || !previewRequest) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await applyBundle({
        eventSlug,
        targetPersonId,
        bundleVersionId: preview.bundleVersionId,
        bindings: previewRequest.bindings,
        ...(previewRequest.validUntil !== undefined
          ? { validUntil: previewRequest.validUntil }
          : {}),
        expectedAccessVersion: preview.expectedAccessVersion,
        previewChecksum: preview.previewChecksum,
        reason,
        clientOperationId: crypto.randomUUID(),
      })
      setMessage(
        `${result.createdCount} permission${result.createdCount === 1 ? '' : 's'} added from ${preview.bundleLabel}.`,
      )
      setPreviewRequest(null)
      setReason('')
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="permission-command bundle-application">
      <div>
        <h2>Add reusable access</h2>
        <p className="muted">
          Choose a published access set, then review the exact permissions before adding them.
        </p>
      </div>
      <form className="bundle-application-form" onSubmit={requestPreview}>
        <label className="field">
          <span>Access set</span>
          <select value={selectedVersionId ?? ''} onChange={(event) => chooseBundle(event.target.value)}>
            <option value="">Choose an access set</option>
            {applicable.map((bundle) => (
              <option key={bundle.versionId} value={bundle.versionId}>
                {bundle.label} · {bundle.entryCount} permissions
              </option>
            ))}
          </select>
        </label>
        {selected?.bindings.map((binding) => (
          <BundleBindingField
            binding={binding}
            key={binding.key}
            targetPersonId={targetPersonId}
            value={bindingValues[binding.key] ?? ''}
            onChange={(value) => {
              setBindingValues((current) => ({ ...current, [binding.key]: value }))
              setPreviewRequest(null)
            }}
          />
        ))}
        <label className="field">
          <span>Expires <small>Optional · defaults to event end when configured</small></span>
          <input
            type="datetime-local"
            value={validUntil}
            onChange={(event) => {
              setValidUntil(event.target.value)
              setPreviewRequest(null)
            }}
          />
        </label>
        <button
          className="secondary"
          type="submit"
          disabled={
            !selected ||
            selected.bindings.some((binding) => !bindingValues[binding.key])
          }
        >
          Review permissions
        </button>
      </form>

      {previewRequest && preview === undefined ? <p className="muted">Preparing access…</p> : null}
      {preview ? (
        <div className="bundle-application-preview">
          <div>
            <strong>{preview.bundleLabel}</strong>
            <span>
              {preview.grants.length} permissions · {preview.grants.filter((grant) => grant.alreadyEffective).length} already available another way
            </span>
          </div>
          <ol>
            {preview.grants.map((grant, index) => (
              <li key={`${grant.permissionKey}:${grant.scopeType}:${grant.scopeId ?? 'event'}:${index}`}>
                <span>{permissionName(grant.permissionKey)}</span>
                <small>
                  {scopeName(grant.scopeType)}
                  {grant.alreadyEffective ? ' · already available' : ''}
                </small>
              </li>
            ))}
          </ol>
          <label className="field">
            <span>Why this person needs it</span>
            <textarea required value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <button
            className="primary"
            type="button"
            disabled={busy || reason.trim().length < 5}
            onClick={() => void apply()}
          >
            {busy ? 'Adding…' : 'Add this access'}
          </button>
          <small className="muted">You may be asked to sign in again before this access change.</small>
        </div>
      ) : null}
      {message ? <p className="notice" role="status">{message}</p> : null}
      {error ? <p className="notice error" role="alert">{error}</p> : null}
    </section>
  )
}
