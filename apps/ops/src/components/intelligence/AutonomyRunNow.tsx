import { api } from '@code2create/backend/api'
import { useMutation } from 'convex/react'
import type { FunctionReturnType } from 'convex/server'
import { useState } from 'react'

import { eventSlug } from '../../lib/config'
import { readableError } from '../../lib/errors'
import { useOperationRunner } from '../../lib/operations'
import type { AutonomyStatus } from '../../lib/operationsAutonomyPresentation'

type AutonomyStart = FunctionReturnType<typeof api.operationsAutonomy.startManual>

const startSlot = 'autonomy-start-manual'

export function AutonomyRunNow({
  autonomy,
  onStarted,
}: {
  autonomy: AutonomyStatus
  onStarted?: (runId: string) => void
}) {
  const startManual = useMutation(api.operationsAutonomy.startManual)
  const operations = useOperationRunner<AutonomyStart>()
  const [error, setError] = useState<string>()
  const pending = operations.hasPending(startSlot)

  const request = async () => {
    setError(undefined)
    try {
      const result = await operations.run(
        startSlot,
        (clientOperationId) => () => startManual({ eventSlug, clientOperationId }),
      )
      if (result.state === 'started') onStarted?.(result.runId)
    } catch (caught) {
      setError(readableError(caught))
    }
  }

  return (
    <div className="grid gap-2">
      <button
        className="secondary"
        disabled={!autonomy.canStart && !pending}
        onClick={() => void request()}
        type="button"
      >
        {pending
          ? 'Confirm earlier request'
          : autonomy.activeRun
            ? 'Queue another review'
            : 'Run a review now'}
      </button>
      {error === undefined ? null : <p className="notice error" role="alert">{error}</p>}
    </div>
  )
}
