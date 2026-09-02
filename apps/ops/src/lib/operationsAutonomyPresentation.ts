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
  if (state === 'leased') return 'Starting'
  if (state === 'accepted') return 'Ready'
  if (state === 'running') return 'Working'
  if (state === 'succeeded') return 'Complete'
  if (state === 'no_op') return 'No action'
  if (state === 'escalated') return 'Escalated'
  if (state === 'canceled') return 'Stopped'
  return 'Failed'
}

export function autonomyRunPhaseLabel(phase: AutonomyRun['phase']) {
  if (phase === 'planning') return 'Planning what to check'
  if (phase === 'reading') return 'Checking event information'
  if (phase === 'investigating') return 'Investigating a problem'
  if (phase === 'criticizing') return 'Testing the conclusion'
  if (phase === 'proposing') return 'Preparing an action'
  if (phase === 'continuing') return 'Continuing the review'
  if (phase === 'finalizing') return 'Saving the result'
  if (phase === 'terminal') return 'Review finished'
  if (phase === 'accepted') return 'Agent started'
  return 'Starting autonomous review'
}

export function autonomyRunTerminalState(state: AutonomyRun['state']): LiveAgentTerminalState {
  if (state === 'canceled') return 'aborted'
  if (state === 'failed') return 'failed'
  if (state === 'succeeded' || state === 'no_op' || state === 'escalated') return 'completed'
  return 'none'
}

export function autonomyFailureLabel(code: AutonomyRun['failureCode']) {
  if (code === 'provider_failed') return 'The AI service did not finish this review.'
  if (code === 'tool_failed') return 'The agent could not read approved evidence or save a proposal.'
  if (code === 'policy_violation') return 'The agent tried to work outside its approved access.'
  if (code === 'callback_rejected') return 'The agent result could not be saved.'
  if (code === 'dispatch_failed') return 'The agent could not start this review.'
  return 'The review ended without a valid result.'
}

export function autonomyCancellationLabel(reason: AutonomyRun['cancellationReason']) {
  if (reason === 'kill_switch') return 'An operator used the autonomy kill switch.'
  if (reason === 'policy_superseded') return 'A newly published policy superseded this run.'
  if (reason === 'owner_revoked') return 'The accountable owner no longer has the required authority.'
  if (reason === 'event_not_live') {
    return 'Applications are closed and the event is not running.'
  }
  return 'The review was canceled by an event state change.'
}
