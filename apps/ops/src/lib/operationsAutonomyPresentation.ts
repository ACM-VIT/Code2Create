import type { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'

import type { LiveAgentTerminalState } from '../components/intelligence'

type AutonomyHistory = FunctionReturnType<typeof api.operationsAutonomy.history>
export type AutonomyRun = AutonomyHistory['page'][number]
type AutonomyQueue = FunctionReturnType<typeof api.operationsAutonomy.queuedWork>
export type AutonomyQueuedWork = AutonomyQueue['page'][number]

export function autonomyRunIsActive(state: AutonomyRun['state']) {
  return state === 'pending' || state === 'leased' || state === 'accepted' || state === 'running'
}

export function autonomyRunCanStream(run: Pick<AutonomyRun, 'hasStream'>) {
  return run.hasStream
}

export function autonomyRunStateLabel(state: AutonomyRun['state']) {
  if (state === 'pending') return 'Queued'
  if (state === 'leased') return 'Dispatching'
  if (state === 'accepted') return 'Accepted'
  if (state === 'running') return 'Working'
  if (state === 'succeeded') return 'Complete'
  if (state === 'no_op') return 'No action'
  if (state === 'escalated') return 'Escalated'
  if (state === 'canceled') return 'Stopped'
  return 'Failed'
}

export function autonomyRunPhaseLabel(phase: AutonomyRun['phase']) {
  if (phase === 'planning') return 'Planning operations review'
  if (phase === 'reading') return 'Reading approved event data'
  if (phase === 'investigating') return 'Investigating event area'
  if (phase === 'criticizing') return 'Checking evidence and conclusions'
  if (phase === 'proposing') return 'Recording recommendation proposal'
  if (phase === 'continuing') return 'Continuing durable review work'
  if (phase === 'finalizing') return 'Finalizing run record'
  if (phase === 'terminal') return 'Terminal record written'
  if (phase === 'accepted') return 'Worker accepted run'
  return 'Starting autonomous review'
}

export function autonomyRunTerminalState(state: AutonomyRun['state']): LiveAgentTerminalState {
  if (state === 'canceled') return 'aborted'
  if (state === 'failed') return 'failed'
  if (state === 'succeeded' || state === 'no_op' || state === 'escalated') return 'completed'
  return 'none'
}

export function autonomyFailureLabel(code: AutonomyRun['failureCode']) {
  if (code === 'provider_failed') return 'The model provider did not complete the run.'
  if (code === 'tool_failed') return 'An approved read or proposal boundary failed.'
  if (code === 'policy_violation') return 'The run attempted work outside its frozen policy.'
  if (code === 'callback_rejected') return 'The authoritative lifecycle callback was rejected.'
  if (code === 'dispatch_failed') return 'The Worker did not accept the immutable run.'
  return 'The run ended before it produced a valid terminal record.'
}

export function autonomyCancellationLabel(reason: AutonomyRun['cancellationReason']) {
  if (reason === 'kill_switch') return 'An operator used the autonomy kill switch.'
  if (reason === 'policy_superseded') return 'A newly published policy superseded this run.'
  if (reason === 'owner_revoked') return 'The accountable owner no longer has the required authority.'
  if (reason === 'event_not_live') return 'The event is no longer live.'
  return 'The run was canceled by an authoritative server transition.'
}
