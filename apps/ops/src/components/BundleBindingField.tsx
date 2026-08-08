import { api } from '@code2create/backend/api'
import type { FunctionArgs } from 'convex/server'
import { usePaginatedQuery } from 'convex/react'

import { eventSlug } from '../lib/config'
import { bindingName, scopeName } from '../lib/permissionLabels'

type TargetPersonId = FunctionArgs<typeof api.access.scopeOptions>['targetPersonId']
type ScopeType = FunctionArgs<typeof api.access.scopeOptions>['requestedScopeType']

export type BundleBindingRequirement = {
  key: string
  scopeType: ScopeType
  permissionKey: string
}

export function BundleBindingField({
  binding,
  targetPersonId,
  value,
  onChange,
}: {
  binding: BundleBindingRequirement
  targetPersonId: TargetPersonId
  value: string
  onChange: (value: string) => void
}) {
  const options = usePaginatedQuery(
    api.access.scopeOptions,
    {
      eventSlug,
      targetPersonId,
      permissionKey: binding.permissionKey,
      requestedScopeType: binding.scopeType,
    },
    { initialNumItems: 40 },
  )
  return (
    <div className="bundle-binding-field">
      <label className="field">
        <span>{bindingName(binding.key)} <small>{scopeName(binding.scopeType)}</small></span>
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose one resource</option>
          {options.results.map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      </label>
      {options.status === 'CanLoadMore' ? (
        <button className="text-button" type="button" onClick={() => options.loadMore(40)}>
          Load more
        </button>
      ) : null}
    </div>
  )
}
