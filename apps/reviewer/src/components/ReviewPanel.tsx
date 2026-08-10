import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { randomUUID } from 'expo-crypto'
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { Stack, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'

import { PagingSetup } from '@/components/PagingSetup'
import { ProjectEvidence } from '@/components/ProjectEvidence'
import { ReviewerSetup } from '@/components/ReviewerSetup'
import {
  Action,
  Body,
  DutyRing,
  Field,
  HeaderButton,
  Meta,
  Nothing,
  Problem,
  Progress,
  QuietAction,
  ScoreRow,
  Section,
  Sheet,
} from '@/components/ui'
import {
  checkEncryptedDraftStorage,
  clearLocalScorecardDraft,
  loadLocalScorecardDraft,
  saveLocalScorecardDraft,
} from '@/lib/local-scorecard'
import {
  currentReviewerPushRegistration,
  requestReviewerPushRegistration,
  subscribeToReviewerPushTokenChanges,
  type ReviewerPushRegistration,
} from '@/lib/push-notifications'
import {
  createReviewerDevice,
  loadReviewerDevice,
  rotateReviewerRegistration,
  type ReviewerDeviceRecord,
  type ReviewerPlatform,
} from '@/lib/reviewer-device'
import { describeError } from '@/lib/errors'
import type { ReviewerRuntime } from '@/lib/runtime'
import { palette, radius } from '@/theme'

type ReviewerNow = FunctionReturnType<typeof api.reviewer.now>
type ActiveReview = NonNullable<ReviewerNow['review']>
type Rating = ActiveReview['scorecard']['ratings'][number]
type Criterion = ActiveReview['criteria'][number]
type DeviceState =
  | { status: 'loading' }
  | { status: 'ready'; record: ReviewerDeviceRecord | null }
  | { status: 'error'; message: string }
type NotificationState = { status: 'loading' } | ReviewerPushRegistration
type DraftStorageState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'unavailable'; message: string }
type BusyAction = 'create' | 'register' | 'clock_in' | 'start' | null
type CorrectionCategory = 'reviewer_error' | 'technical_error' | 'other'

const scores = [0, 1, 2, 3, 4] as const

export function ReviewPanel({ runtime }: { runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug
  const platform = reviewerPlatform()
  const [cameraPermission, requestCameraPermission] = useCameraPermissions()
  const [notificationState, setNotificationState] = useState<NotificationState>({ status: 'loading' })
  const [draftStorageState, setDraftStorageState] = useState<DraftStorageState>({ status: 'loading' })
  const [deviceState, setDeviceState] = useState<DeviceState>(() =>
    platform ? { status: 'loading' } : { status: 'ready', record: null },
  )
  const [busy, setBusy] = useState<BusyAction>(null)
  const [error, setErrorState] = useState<{ message: string; raisedWhile: string | undefined } | null>(null)
  const [heartbeatIssue, setHeartbeatIssue] = useState<string | null>(null)
  const [pagingOpen, setPagingOpen] = useState(false)
  const createBusyRef = useRef(false)
  const clockInOperationRef = useRef<string | null>(null)
  const startOperationRef = useRef<string | null>(null)
  const router = useRouter()
  const registerDevice = useMutation(api.reviewer.registerDevice)
  const clockIn = useMutation(api.reviewer.clockIn)
  const startReview = useMutation(api.reviewOperations.startReview)
  const heartbeat = useMutation(api.reviewer.heartbeat)

  useEffect(() => {
    if (!platform) return
    let active = true
    void loadReviewerDevice(eventSlug)
      .then((record) => {
        if (active) setDeviceState({ status: 'ready', record })
      })
      .catch((caught: Error) => {
        if (active) setDeviceState({ status: 'error', message: caught.message })
      })
    return () => {
      active = false
    }
  }, [eventSlug, platform])

  useEffect(() => {
    if (!platform) return
    let active = true
    void currentReviewerPushRegistration(runtime.configuration.apnsEnvironment).then((registration) => {
      if (active) setNotificationState(registration)
    })
    return () => {
      active = false
    }
  }, [platform, runtime.configuration.apnsEnvironment])

  useEffect(() => {
    if (!platform) return
    return subscribeToReviewerPushTokenChanges(
      runtime.configuration.apnsEnvironment,
      setNotificationState,
    )
  }, [platform, runtime.configuration.apnsEnvironment])

  useEffect(() => {
    if (!platform) return
    let active = true
    void checkEncryptedDraftStorage(eventSlug)
      .then(() => {
        if (active) setDraftStorageState({ status: 'ready' })
      })
      .catch((caught: Error) => {
        if (active) setDraftStorageState({ status: 'unavailable', message: caught.message })
      })
    return () => {
      active = false
    }
  }, [eventSlug, platform])

  const deviceRecord = deviceState.status === 'ready' ? deviceState.record : null
  const current = useQuery(
    api.reviewer.now,
    deviceRecord ? { eventSlug, installationId: deviceRecord.installationId } : 'skip',
  )
  const heartbeatRoundId = current?.panel?.round.id ?? current?.reserve?.round.id
  const heartbeatStatus = current?.panel?.clockIn?.status ?? current?.reserve?.clockIn?.status
  const heartbeatInstallationId = deviceRecord?.installationId

  /* An error describes an action the server refused, under the duty state it
     refused it in. Once that state moves on the sentence is no longer true,
     and leaving it up tells a reviewer who is on duty that they are not — so
     it is remembered against that state rather than cleared by an effect. */
  const setError = (message: string | null) => {
    setErrorState(message === null ? null : { message, raisedWhile: heartbeatStatus })
  }
  const visibleError = error && error.raisedWhile === heartbeatStatus ? error.message : null

  useEffect(() => {
    if (
      !heartbeatInstallationId ||
      !heartbeatRoundId ||
      (heartbeatStatus !== 'present' && heartbeatStatus !== 'temporarily_unavailable')
    ) {
      return
    }
    let active = true
    const send = async () => {
      try {
        await heartbeat({
          eventSlug,
          roundId: heartbeatRoundId,
          installationId: heartbeatInstallationId,
        })
        if (active) setHeartbeatIssue(null)
      } catch {
        if (active) setHeartbeatIssue('Live panel connection is interrupted. Actions still require a server response.')
      }
    }
    void send()
    const timer = setInterval(() => void send(), 45_000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [eventSlug, heartbeat, heartbeatInstallationId, heartbeatRoundId, heartbeatStatus])

  if (!platform) {
    return (
      <Panel>
        <Text style={styles.heading}>Project reviews</Text>
        <Text style={styles.body}>Open reviewer mode on an assigned Android phone or iPhone.</Text>
      </Panel>
    )
  }
  if (deviceState.status === 'loading') {
    return <Panel><Text style={styles.body}>Loading reviewer setup…</Text></Panel>
  }
  if (deviceState.status === 'error') {
    return (
      <Panel>
        <Text style={styles.heading}>Reviewer setup needs attention</Text>
        <Text style={styles.error}>{deviceState.message}</Text>
      </Panel>
    )
  }

  const createDevice = async () => {
    if (createBusyRef.current) return
    createBusyRef.current = true
    setBusy('create')
    setError(null)
    try {
      const record = await createReviewerDevice(eventSlug, platform)
      setDeviceState({ status: 'ready', record })
    } catch (caught) {
      setError(errorMessage(caught, 'This phone could not be prepared.'))
    } finally {
      createBusyRef.current = false
      setBusy(null)
    }
  }

  if (!deviceRecord) {
    return (
      <Panel>
        <Text style={styles.heading}>Set up reviewer mode</Text>
        <Text style={styles.body}>This creates one installation record for the signed-in reviewer on this phone.</Text>
        <Button
          label={busy === 'create' ? 'Preparing…' : 'Set up this phone'}
          disabled={busy !== null}
          onPress={createDevice}
        />
        {error ? <Text style={styles.error}>{error.message}</Text> : null}
      </Panel>
    )
  }
  if (current === undefined) {
    return <Panel><Text style={styles.body}>Loading your current panel…</Text></Panel>
  }
  const cameraReady = Boolean(cameraPermission?.granted)
  const notificationsReady = notificationState.status === 'ready'
  const encryptedDraftReady = draftStorageState.status === 'ready'
  const assignment = current.panel ?? current.reserve
  const round = assignment?.round
  const checksMeetRound =
    (!round?.requiresCamera || cameraReady) &&
    (!round?.requiresNotifications || notificationsReady) &&
    encryptedDraftReady
  const deviceIsCurrent =
    current.device?.appBuild === runtime.configuration.appBuild &&
    current.device.cameraReady === cameraReady &&
    current.device.notificationsReady === notificationsReady &&
    current.device.pushTokenFingerprint ===
      (notificationState.status === 'ready' ? notificationState.fingerprint : undefined) &&
    current.device.encryptedDraftReady === encryptedDraftReady

  const requestNotifications = async () => {
    setError(null)
    setNotificationState({ status: 'loading' })
    const registration = await requestReviewerPushRegistration(runtime.configuration.apnsEnvironment)
    setNotificationState(registration)
    if (registration.status === 'unavailable') setError(registration.message)
  }

  const saveDeviceRegistration = async () => {
    if (busy) return
    setBusy('register')
    setError(null)
    try {
      await registerDevice({
        eventSlug,
        installationId: deviceRecord.installationId,
        name: deviceRecord.deviceName,
        platform: deviceRecord.platform,
        appBuild: runtime.configuration.appBuild,
        cameraReady,
        ...(notificationState.status === 'ready'
          ? {
              pushToken: notificationState.token,
              pushProvider: notificationState.provider,
              pushEnvironment: notificationState.environment,
            }
          : {}),
        encryptedDraftReady,
        expectedVersion: current.device?.version ?? 0,
        clientOperationId: deviceRecord.registrationOperationId,
      })
      const nextRecord = await rotateReviewerRegistration(eventSlug, deviceRecord)
      setDeviceState({ status: 'ready', record: nextRecord })
    } catch (caught) {
      setError(errorMessage(caught, 'This phone could not be registered.'))
    } finally {
      setBusy(null)
    }
  }

  const clockIntoRound = async () => {
    if (!assignment || busy) return
    const clientOperationId = clockInOperationRef.current ?? randomUUID()
    clockInOperationRef.current = clientOperationId
    setBusy('clock_in')
    setError(null)
    try {
      await clockIn({
        eventSlug,
        roundId: assignment.round.id,
        installationId: deviceRecord.installationId,
        expectedVersion: assignment.clockIn?.version ?? 0,
        clientOperationId,
      })
      clockInOperationRef.current = null
    } catch (caught) {
      setError(errorMessage(caught, 'Clock-in could not be completed.'))
    } finally {
      setBusy(null)
    }
  }

  const beginReview = async () => {
    if (!current.review || busy) return
    const clientOperationId = startOperationRef.current ?? randomUUID()
    startOperationRef.current = clientOperationId
    setBusy('start')
    setError(null)
    try {
      await startReview({
        eventSlug,
        reviewSessionId: current.review.id,
        expectedVersion: current.review.version,
        reason: 'Panel coordinator started the scheduled review',
        clientOperationId,
      })
      startOperationRef.current = null
    } catch (caught) {
      setError(errorMessage(caught, 'The review could not start.'))
    } finally {
      setBusy(null)
    }
  }

  if (!current.panel && !current.reserve && !current.review) {
    return (
      <Panel>
        <Nothing>No current review duty</Nothing>
      </Panel>
    )
  }

  const clockedIn = assignment?.clockIn?.status === 'present'
  const review = current.review
  const everyonePresent = review
    ? review.assignment.reviewerPresenceCount === review.assignment.reviewerCount
    : false

  return (
    <Panel>
      <View style={styles.headingRow}>
        <View style={styles.flex}>
          <Text style={styles.heading}>{assignment?.round.name ?? review?.round.name}</Text>
        </View>
        {review?.team.tableLabel ? <Text style={styles.table}>{review.team.tableLabel}</Text> : null}
      </View>

      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton
              label="This phone"
              onPress={() =>
                router.push({
                  pathname: '/duty/reviewer-phone',
                  params: {
                    ...(current.panel ? { panel: current.panel.name } : {}),
                    build: `${runtime.configuration.appBuild}`,
                    camera: cameraReady ? 'Ready' : 'Not allowed',
                    notifications: notificationLabel(
                      notificationState,
                      current.device?.pushTokenStatus,
                    ),
                    drafts: encryptedDraftReady ? 'Ready' : 'Unavailable',
                  },
                })
              }
            />
          ),
        }}
      />

      {round?.isPaused ? (
        <View style={styles.pauseNotice}>
          <Text style={styles.value}>New reviews are paused.</Text>
          <Text style={styles.body}>
            Keep this assignment open. A review already underway may continue and finish, but another one cannot start yet.
          </Text>
        </View>
      ) : null}

      {!deviceIsCurrent && assignment ? (
        <ReviewerSetup
          busy={busy !== null || notificationState.status === 'loading'}
          cameraReady={cameraReady}
          draftsReady={encryptedDraftReady}
          onOpenPaging={() => setPagingOpen(true)}
          onRegister={saveDeviceRegistration}
          onRequestCamera={async () => {
            await requestCameraPermission()
          }}
          pagingReady={notificationsReady}
          ready={checksMeetRound}
          registerLabel={
            busy === 'register'
              ? 'Saving…'
              : current.device
                ? 'Update this phone'
                : 'Register this phone'
          }
        />
      ) : null}

      {/* Reachable from the checklist, and on Android from the duty screen too:
          two of its switches cannot be read back, so granting notifications
          must not hide the screen explaining why a page still arrives
          silently. */}
      {deviceIsCurrent && (!notificationsReady || Platform.OS === 'android') ? (
        <Button label="Getting paged" secondary onPress={() => setPagingOpen(true)} />
      ) : null}
      <Sheet onClose={() => setPagingOpen(false)} title="Getting paged" visible={pagingOpen}>
        <PagingSetup
          onDone={() => setPagingOpen(false)}
          requestPermission={requestNotifications}
          tokenRejected={current.device?.pushTokenStatus === 'invalid'}
        />
      </Sheet>

      {/* The checklist says what is missing; these say the phone itself is the
          problem, which no amount of pressing will fix. */}
      {notificationState.status === 'unavailable' && round?.requiresNotifications ? (
        <Text style={styles.error}>{notificationState.message}</Text>
      ) : null}
      {draftStorageState.status === 'unavailable' ? (
        <Text style={styles.error}>{draftStorageState.message}</Text>
      ) : null}

      {deviceIsCurrent && assignment && !review ? (
        <DutyRing
          accent={palette.judging}
          busy={busy === 'clock_in'}
          {...(clockedIn ? { detail: dutyStateDetail(current) } : {})}
          disabled={busy !== null || !checksMeetRound}
          label={clockedIn ? 'On duty' : assignment.clockIn ? 'Return to duty' : 'Clock in'}
          on={clockedIn}
          onPress={clockIntoRound}
        />
      ) : null}

      {clockedIn && !review ? (
        <View style={styles.waiting}>
          {assignment ? (
            <AvailabilityControl
              eventSlug={eventSlug}
              installationId={deviceRecord.installationId}
              assignment={assignment}
            />
          ) : null}
        </View>
      ) : null}

      {review ? (
        <>
          <View style={styles.rule} />
          <ReviewHeading review={review} serverNow={current.serverNow} />
          {review.status === 'awaiting_presence' ? (
            <ConflictReport eventSlug={eventSlug} review={review} />
          ) : null}
          {!review.assignment.reviewerPresenceConfirmed && review.status === 'awaiting_presence' ? (
            <ReviewQrScanner
              eventSlug={eventSlug}
              installationId={deviceRecord.installationId}
            />
          ) : null}
          {review.assignment.reviewerPresenceConfirmed && review.status === 'awaiting_presence' ? (
            <View style={styles.waiting}>
              <Text style={styles.value}>Your place is confirmed.</Text>
              <Text style={styles.body}>
                {everyonePresent
                  ? round?.isPaused
                    ? 'Every reviewer is here. Wait for operations to resume new starts.'
                    : review.assignment.isCoordinator
                      ? 'Every reviewer is here. Start when the team is settled.'
                      : 'Every reviewer is here. The panel coordinator will start.'
                  : `${review.assignment.reviewerPresenceCount} of ${review.assignment.reviewerCount} reviewers are confirmed.`}
              </Text>
              {everyonePresent && review.assignment.isCoordinator && !round?.isPaused ? (
                <Button
                  label={busy === 'start' ? 'Starting…' : 'Start review'}
                  disabled={busy !== null}
                  onPress={beginReview}
                />
              ) : null}
            </View>
          ) : null}
          {review.status === 'active' || review.status === 'overdue' ? (
            <ReviewWorkspace
              eventSlug={eventSlug}
              installationId={deviceRecord.installationId}
              review={review}
            />
          ) : null}
          {review.scorecard.status === 'correction_open' ? (
            <ReviewWorkspace
              eventSlug={eventSlug}
              installationId={deviceRecord.installationId}
              review={review}
            />
          ) : null}
        </>
      ) : null}

      <CorrectionRequests eventSlug={eventSlug} />

      {visibleError ? <Text style={styles.error}>{visibleError}</Text> : null}
      {heartbeatIssue ? <Text style={styles.error}>{heartbeatIssue}</Text> : null}
    </Panel>
  )
}

function CorrectionRequests({ eventSlug }: { eventSlug: string }) {
  const options = useQuery(api.scoreGovernance.myCorrectionOptions, { eventSlug })
  const requestCorrection = useMutation(api.scoreGovernance.requestCorrection)
  const [selectedScorecardId, setSelectedScorecardId] = useState<string | null>(null)
  const [category, setCategory] = useState<CorrectionCategory>('reviewer_error')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  if (options === undefined || options.length === 0) return null

  const resetOperation = () => {
    operationRef.current = null
    setError(null)
  }

  const submit = async () => {
    const option = options.find((candidate) => candidate.scorecardId === selectedScorecardId)
    if (!option || !option.canRequest || reason.trim().length < 5 || busy) return
    const clientOperationId = operationRef.current ?? randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await requestCorrection({
        eventSlug,
        scorecardId: option.scorecardId,
        expectedScorecardVersion: option.scorecardVersion,
        category,
        reason,
        clientOperationId,
      })
      operationRef.current = null
      setSelectedScorecardId(null)
      setReason('')
    } catch (caught) {
      setError(errorMessage(caught, 'The correction request could not be sent.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Submitted scorecards</Text>
      <Text style={styles.body}>A correction changes only your own scorecard and needs operations approval.</Text>
      {options.map((option) => {
        const selected = selectedScorecardId === option.scorecardId
        return (
          <View key={option.scorecardId} style={styles.evidenceRow}>
            <Text style={styles.value}>{option.teamName}</Text>
            <Text style={styles.meta}>{option.roundName}</Text>
            {option.currentCase?.state === 'requested' ? (
              <Text style={styles.body}>Correction requested · waiting for operations</Text>
            ) : null}
            {option.currentCase?.state === 'rejected' ? (
              <Text style={styles.body}>
                Request declined{option.currentCase.decisionReason ? ` · ${option.currentCase.decisionReason}` : ''}
              </Text>
            ) : null}
            {option.currentCase?.state === 'closed' ? (
              <Text style={styles.body}>The previous correction was submitted and retained in history.</Text>
            ) : null}
            {option.canRequest && !selected ? (
              <Button
                label="Request correction"
                secondary
                onPress={() => {
                  setSelectedScorecardId(option.scorecardId)
                  setCategory('reviewer_error')
                  setReason('')
                  resetOperation()
                }}
              />
            ) : null}
            {selected ? (
              <View style={styles.availabilityBlock}>
                <Text style={styles.label}>What happened?</Text>
                <View style={styles.buttonRow}>
                  <Button
                    label="My scoring error"
                    secondary={category !== 'reviewer_error'}
                    onPress={() => {
                      setCategory('reviewer_error')
                      resetOperation()
                    }}
                  />
                  <Button
                    label="Technical issue"
                    secondary={category !== 'technical_error'}
                    onPress={() => {
                      setCategory('technical_error')
                      resetOperation()
                    }}
                  />
                </View>
                <TextInput
                  editable={!busy}
                  multiline
                  onChangeText={(value) => {
                    setReason(value)
                    resetOperation()
                  }}
                  placeholder="Briefly explain what needs correction"
                  placeholderTextColor={palette.faint}
                  style={styles.input}
                  value={reason}
                />
                <View style={styles.buttonRow}>
                  <Button
                    label={busy ? 'Sending…' : 'Send request'}
                    disabled={busy || reason.trim().length < 5}
                    onPress={submit}
                  />
                  <Button
                    label="Cancel"
                    disabled={busy}
                    secondary
                    onPress={() => {
                      setSelectedScorecardId(null)
                      setReason('')
                      resetOperation()
                    }}
                  />
                </View>
              </View>
            ) : null}
          </View>
        )
      })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}

function AvailabilityControl({
  eventSlug,
  installationId,
  assignment,
}: {
  eventSlug: string
  installationId: string
  assignment: NonNullable<ReviewerNow['panel']> | NonNullable<ReviewerNow['reserve']>
}) {
  const setAvailability = useMutation(api.reviewer.setAvailability)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [returnMinutes, setReturnMinutes] = useState('10')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const clockIn = assignment.clockIn
  if (!clockIn) return null

  const changed = () => {
    operationRef.current = null
    setError(null)
  }

  const stepAway = async () => {
    const minutes = Number(returnMinutes)
    if (!Number.isSafeInteger(minutes) || minutes < 1) {
      setError('Expected return must be a positive whole number of minutes.')
      return
    }
    const clientOperationId = operationRef.current ?? randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await setAvailability({
        eventSlug,
        roundId: assignment.round.id,
        installationId,
        status: 'temporarily_unavailable',
        reason,
        expectedReturnAt: Date.now() + minutes * 60_000,
        expectedVersion: clockIn.version,
        clientOperationId,
      })
      operationRef.current = null
    } catch (caught) {
      setError(errorMessage(caught, 'Availability could not be changed.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button label="Step away briefly" secondary onPress={() => setOpen(true)} />
      <Sheet onClose={() => setOpen(false)} title="Step away" visible={open}>
      <Text style={styles.label}>Short operational reason</Text>
      <TextInput
        editable={!busy}
        onChangeText={(value) => {
          setReason(value)
          changed()
        }}
        placeholder="For example: returning after a break"
        placeholderTextColor={palette.faint}
        style={styles.input}
        value={reason}
      />
      <Text style={styles.label}>Expected return in minutes</Text>
      <TextInput
        editable={!busy}
        inputMode="numeric"
        keyboardType="number-pad"
        onChangeText={(value) => {
          setReturnMinutes(value)
          changed()
        }}
        style={styles.shortInput}
        value={returnMinutes}
      />
      <Button
        label={busy ? 'Updating…' : 'Confirm step away'}
        disabled={busy || reason.trim().length < 3}
        onPress={stepAway}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      </Sheet>
    </>
  )
}

function ConflictReport({ eventSlug, review }: { eventSlug: string; review: ActiveReview }) {
  const reportConflict = useMutation(api.reviewer.reportConflict)
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const submit = async () => {
    if (busy || reason.trim().length < 3) return
    const clientOperationId = operationRef.current ?? randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      await reportConflict({
        eventSlug,
        reviewSessionId: review.id,
        reason,
        clientOperationId,
      })
      operationRef.current = null
    } catch (caught) {
      setError(errorMessage(caught, 'The conflict could not be reported.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)}>
        <Text style={styles.textButton}>I have a conflict with this team</Text>
      </Pressable>
      <Sheet onClose={() => setOpen(false)} title="Report a conflict" visible={open}>
      {/* This cancels the pending review and reroutes the team, so it says so
          rather than leaving somebody to find out by pressing it. */}
      <Text style={styles.body}>The team returns to the queue for another panel.</Text>
      <TextInput
        editable={!busy}
        multiline
        onChangeText={(value) => {
          setReason(value)
          operationRef.current = null
          setError(null)
        }}
        placeholder="Brief relationship or policy conflict"
        placeholderTextColor={palette.faint}
        style={styles.input}
        value={reason}
      />
      <Button
        label={busy ? 'Reporting…' : 'Report and reroute team'}
        disabled={busy || reason.trim().length < 3}
        onPress={submit}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      </Sheet>
    </>
  )
}

function ReviewQrScanner({
  eventSlug,
  installationId,
}: {
  eventSlug: string
  installationId: string
}) {
  const [permission, requestPermission] = useCameraPermissions()
  const confirmPresence = useMutation(api.reviewer.confirmPresence)
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualCode, setManualCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const confirm = async (payload: string) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setScanning(false)
    setError(null)
    try {
      await confirmPresence({ eventSlug, installationId, payload })
      setManualCode('')
    } catch (caught) {
      setError(errorMessage(caught, 'The team code could not be confirmed.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const scan = (result: BarcodeScanningResult) => void confirm(result.data)

  if (manualOpen) {
    return (
      <View style={styles.waiting}>
        <Text style={styles.body}>Enter the 12-character fallback code shown beneath the team QR.</Text>
        <TextInput
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!busy}
          onChangeText={(value) => {
            setManualCode(value.toUpperCase())
            setError(null)
          }}
          placeholder="ABCD-EFGH-JKLM"
          placeholderTextColor={palette.faint}
          style={styles.codeInput}
          value={manualCode}
        />
        <View style={styles.buttonRow}>
          <Button
            label="Confirm team code"
            disabled={manualCode.replaceAll(/[^A-Z0-9]/g, '').length !== 12 || busy}
            onPress={() => confirm(manualCode)}
          />
          <Button label="Cancel" secondary onPress={() => setManualOpen(false)} />
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    )
  }

  if (!permission?.granted) {
    return (
      <View style={styles.waiting}>
        <Text style={styles.body}>Camera access is needed to scan the team’s short-lived code.</Text>
        <Button label="Allow camera" onPress={async () => { await requestPermission() }} />
        <Button label="Type code instead" secondary onPress={() => setManualOpen(true)} />
      </View>
    )
  }
  if (!scanning) {
    return (
      <View style={styles.waiting}>
        <Text style={styles.body}>Ask the team to open its current review code.</Text>
        <Button label="Scan team code" onPress={() => setScanning(true)} />
        <Button label="Type code instead" secondary onPress={() => setManualOpen(true)} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    )
  }
  return (
    <View style={styles.scannerBlock}>
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scan}
        style={styles.camera}
      />
      <Button label="Cancel scan" secondary onPress={() => setScanning(false)} />
    </View>
  )
}

function ReviewHeading({ review, serverNow }: { review: ActiveReview; serverNow: number }) {
  return (
    <View style={styles.reviewHeading}>
      {/* Spot labels come verbatim from the operator's floor plan and often
          already read "Table 12", so they are never prefixed. */}
      <Text style={styles.eyebrow}>{review.team.tableLabel ?? 'No table yet'}</Text>
      <Text style={styles.reviewTitle}>{review.team.name}</Text>
      <Text style={styles.body}>{review.project.trackName}</Text>
      {review.project.sponsorTracks.length > 0 ? (
        <View>
          <Text style={styles.meta}>Sponsor tracks</Text>
          {review.project.sponsorTracks.map((track) => (
            <Text key={track.id} style={styles.meta}>{track.name} · {track.eligibilityText}</Text>
          ))}
        </View>
      ) : null}
      {review.plannedEndAt ? (
        <ReviewClock
          key={serverNow}
          overdue={review.status === 'overdue'}
          plannedEndAt={review.plannedEndAt}
          serverNow={serverNow}
        />
      ) : null}
    </View>
  )
}

function ReviewClock({
  plannedEndAt,
  serverNow,
  overdue,
}: {
  plannedEndAt: number
  serverNow: number
  overdue: boolean
}) {
  const [estimatedServerNow, setEstimatedServerNow] = useState(serverNow)
  useEffect(() => {
    const observedAt = Date.now()
    const timer = setInterval(
      () => setEstimatedServerNow(serverNow + Date.now() - observedAt),
      1_000,
    )
    return () => clearInterval(timer)
  }, [serverNow])
  const remainingSeconds = Math.ceil((plannedEndAt - estimatedServerNow) / 1_000)
  const absoluteSeconds = Math.abs(remainingSeconds)
  const minutes = Math.floor(absoluteSeconds / 60)
  const seconds = absoluteSeconds % 60
  return (
    <Text style={overdue || remainingSeconds < 0 ? styles.overdue : styles.timer}>
      {remainingSeconds < 0 ? '+' : ''}{minutes}:{seconds.toString().padStart(2, '0')}
    </Text>
  )
}

function ReviewWorkspace({
  eventSlug,
  installationId,
  review,
}: {
  eventSlug: string
  installationId: string
  review: ActiveReview
}) {
  return (
    <View style={styles.workspace}>
      <ProjectEvidence eventSlug={eventSlug} review={review} />
      {review.assignment.isCoordinator && review.scorecard.status !== 'correction_open' ? (
        <CoordinatorNotes eventSlug={eventSlug} review={review} />
      ) : null}
      <ScorecardEditor
        eventSlug={eventSlug}
        installationId={installationId}
        review={review}
      />
    </View>
  )
}

function CoordinatorNotes({ eventSlug, review }: { eventSlug: string; review: ActiveReview }) {
  const saveSharedNotes = useMutation(api.reviewOperations.saveSharedNotes)
  const [findings, setFindings] = useState(review.sharedFindings ?? '')
  const [commitments, setCommitments] = useState(review.sharedCommitments ?? '')
  const [notesVersion, setNotesVersion] = useState(review.sharedNotesVersion)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationRef = useRef<string | null>(null)

  const edit = () => {
    setDirty(true)
    setError(null)
    operationRef.current = null
  }

  const save = async () => {
    if (busy || !findings.trim() || !commitments.trim()) return
    const clientOperationId = operationRef.current ?? randomUUID()
    operationRef.current = clientOperationId
    setBusy(true)
    setError(null)
    try {
      const result = await saveSharedNotes({
        eventSlug,
        reviewSessionId: review.id,
        findings,
        commitments,
        expectedNotesVersion: notesVersion,
        clientOperationId,
      })
      setNotesVersion(result.sharedNotesVersion)
      setDirty(false)
      operationRef.current = null
    } catch (caught) {
      setError(errorMessage(caught, 'The shared notes could not be saved.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Panel notes</Text>
      <Text style={styles.label}>What did the panel observe?</Text>
      <TextInput
        editable={!busy}
        multiline
        onChangeText={(value) => {
          setFindings(value)
          edit()
        }}
        placeholder="A short factual summary"
        placeholderTextColor={palette.faint}
        style={styles.input}
        value={findings}
      />
      <Text style={styles.label}>What should the team show next?</Text>
      <TextInput
        editable={!busy}
        multiline
        onChangeText={(value) => {
          setCommitments(value)
          edit()
        }}
        placeholder="Concrete next-checkpoint commitments"
        placeholderTextColor={palette.faint}
        style={styles.input}
        value={commitments}
      />
      <Button
        label={busy ? 'Saving…' : dirty ? 'Save panel notes' : 'Panel notes saved'}
        disabled={busy || !dirty || !findings.trim() || !commitments.trim()}
        secondary
        onPress={save}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  )
}

function ScorecardEditor({
  eventSlug,
  installationId,
  review,
}: {
  eventSlug: string
  installationId: string
  review: ActiveReview
}) {
  const saveScorecardDraft = useMutation(api.reviewer.saveDraft)
  const submitScorecard = useMutation(api.reviewer.submitScorecard)
  const [initialDraft] = useState(() => ({
    scorecardId: review.scorecard.id,
    serverDraftVersion: review.scorecard.draftVersion,
    criteria: review.criteria,
    submitted: review.scorecard.status === 'submitted',
  }))
  const [ratings, setRatings] = useState<Rating[]>(review.scorecard.ratings)
  const [privateNote, setPrivateNote] = useState(review.scorecard.privateNote ?? '')
  const [draftVersion, setDraftVersion] = useState(review.scorecard.draftVersion)
  const [dirty, setDirty] = useState(false)
  const [submitted, setSubmitted] = useState(review.scorecard.status === 'submitted')
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [localState, setLocalState] = useState<'loading' | 'ready' | 'restored'>('loading')
  const [localError, setLocalError] = useState<string | null>(null)
  const saveOperationRef = useRef<string | null>(null)
  const submitOperationRef = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    const restore = async () => {
      try {
        const stored = await loadLocalScorecardDraft(eventSlug, initialDraft.scorecardId)
        if (!active) return
        if (initialDraft.submitted) {
          await clearLocalScorecardDraft(eventSlug, initialDraft.scorecardId)
          if (active) setLocalState('ready')
          return
        }
        if (stored && stored.serverDraftVersion === initialDraft.serverDraftVersion) {
          const restoredRatings: Rating[] = stored.ratings.flatMap((storedRating) => {
            const criterion = initialDraft.criteria.find(
              (candidate) => candidate.id === storedRating.criterionId,
            )
            if (!criterion) return []
            return [{
              criterionId: criterion.id,
              score: storedRating.score,
              ...(storedRating.evidenceNote !== undefined
                ? { evidenceNote: storedRating.evidenceNote }
                : {}),
            }]
          })
          setRatings(restoredRatings)
          setPrivateNote(stored.privateNote)
          setDirty(true)
          setLocalState('restored')
          return
        }
        if (stored) await clearLocalScorecardDraft(eventSlug, initialDraft.scorecardId)
        if (active) setLocalState('ready')
      } catch (caught) {
        if (!active) return
        setLocalError(errorMessage(caught, 'Encrypted local draft storage is unavailable.'))
        setLocalState('ready')
      }
    }
    void restore()
    return () => {
      active = false
    }
  }, [eventSlug, initialDraft])

  useEffect(() => {
    if (!dirty || localState === 'loading' || submitted) return
    const timer = setTimeout(() => {
      void saveLocalScorecardDraft({
        eventSlug,
        scorecardId: review.scorecard.id,
        serverDraftVersion: draftVersion,
        ratings: ratings.map((rating) => ({
          criterionId: rating.criterionId,
          score: rating.score,
          ...(rating.evidenceNote !== undefined ? { evidenceNote: rating.evidenceNote } : {}),
        })),
        privateNote,
      }).then(
        () => setLocalError(null),
        (caught: unknown) => setLocalError(errorMessage(caught, 'The encrypted local draft could not be updated.')),
      )
    }, 250)
    return () => clearTimeout(timer)
  }, [draftVersion, dirty, eventSlug, localState, privateNote, ratings, review.scorecard.id, submitted])

  const edit = () => {
    setDirty(true)
    saveOperationRef.current = null
    submitOperationRef.current = null
    setError(null)
  }

  const setScore = (criterionId: Criterion['id'], score: number) => {
    setRatings((current) => {
      const existing = current.find((rating) => rating.criterionId === criterionId)
      if (!existing) return [...current, { criterionId, score }]
      return current.map((rating) =>
        rating.criterionId === criterionId ? { ...rating, score } : rating,
      )
    })
    edit()
  }

  const setEvidenceNote = (criterionId: Criterion['id'], evidenceNote: string) => {
    setRatings((current) =>
      current.map((rating) =>
        rating.criterionId === criterionId ? { ...rating, evidenceNote } : rating,
      ),
    )
    edit()
  }

  const save = async () => {
    if (busy) return null
    const clientOperationId = saveOperationRef.current ?? randomUUID()
    saveOperationRef.current = clientOperationId
    setBusy('save')
    setError(null)
    try {
      const result = await saveScorecardDraft({
        eventSlug,
        installationId,
        scorecardId: review.scorecard.id,
        ratings,
        ...(privateNote.trim() ? { privateNote } : {}),
        expectedDraftVersion: draftVersion,
        clientOperationId,
      })
      setDraftVersion(result.draftVersion)
      setDirty(false)
      saveOperationRef.current = null
      try {
        await clearLocalScorecardDraft(eventSlug, review.scorecard.id)
        setLocalError(null)
      } catch (caught) {
        setLocalError(errorMessage(caught, 'The saved local draft could not be cleared.'))
      }
      return result.draftVersion
    } catch (caught) {
      setError(errorMessage(caught, 'The draft could not be saved.'))
      return null
    } finally {
      setBusy(null)
    }
  }

  const submit = async (expectedDraftVersion: number) => {
    if (busy) return
    const clientOperationId = submitOperationRef.current ?? randomUUID()
    submitOperationRef.current = clientOperationId
    setBusy('submit')
    setError(null)
    try {
      await submitScorecard({
        eventSlug,
        installationId,
        scorecardId: review.scorecard.id,
        expectedDraftVersion,
        clientOperationId,
      })
      setSubmitted(true)
      submitOperationRef.current = null
      try {
        await clearLocalScorecardDraft(eventSlug, review.scorecard.id)
        setLocalError(null)
      } catch (caught) {
        setLocalError(errorMessage(caught, 'The submitted local draft could not be cleared.'))
      }
    } catch (caught) {
      setError(errorMessage(caught, 'The scorecard could not be submitted.'))
    } finally {
      setBusy(null)
    }
  }

  const prepareSubmission = async () => {
    const problem = submissionProblem(review.criteria, ratings)
    if (problem) {
      setError(problem)
      return
    }
    const version = dirty ? await save() : draftVersion
    if (version === null) return
    Alert.alert(
      'Submit scorecard?',
      'Your scores become fixed. Only an audited correction opened by operations can change them.',
      [
        { text: 'Keep editing', style: 'cancel' },
        { text: 'Submit', style: 'destructive', onPress: () => void submit(version) },
      ],
    )
  }

  if (submitted) {
    return (
      <Section title="Submitted">
        <Body>Your scores are locked. No other reviewer can see them.</Body>
      </Section>
    )
  }

  const scored = review.criteria.filter((criterion) =>
    ratings.some((rating) => rating.criterionId === criterion.id),
  ).length
  const correcting = review.scorecard.status === 'correction_open'

  return (
    <Section title={correcting ? 'Correction' : 'Your scorecard'}>
      {/* How far through, before anything else. A judge wants to know how many
          are left far more often than they want to be told the rules. */}
      <Progress done={scored} total={review.criteria.length} />
      <Meta>{`${scored} of ${review.criteria.length} scored`}</Meta>
      {localError ? <Problem>{localError}</Problem> : null}

      {review.criteria.map((criterion) => {
        const rating = ratings.find((candidate) => candidate.criterionId === criterion.id)
        // A note is only demanded at the ends of the scale, where a score is a
        // claim someone may later have to defend.
        const noteRequired = rating ? rating.score === 0 || rating.score === 4 : false
        return (
          <View key={criterion.id} style={styles.criterion}>
            <Text style={styles.criterionLabel}>{criterion.label}</Text>
            <Text style={styles.criterionQuestion}>{criterion.question}</Text>
            <ScoreRow
              disabled={busy !== null || localState === 'loading'}
              onSelect={(score) => setScore(criterion.id, score)}
              scores={scores}
              selected={rating?.score}
            />
            {/* The anchor for the chosen score, not the whole rubric. Guidance
                for four scores you did not pick is noise at a table. */}
            <Text style={styles.anchor}>
              {rating ? anchorText(criterion, rating.score) : criterion.guidance}
            </Text>
            {rating ? (
              <Field
                editable={busy === null && localState !== 'loading'}
                label={noteRequired ? 'Why this score (required)' : 'Note (optional)'}
                multiline
                onChangeText={(value) => setEvidenceNote(criterion.id, value)}
                placeholder="What you saw."
                value={rating.evidenceNote ?? ''}
              />
            ) : null}
          </View>
        )
      })}

      <Field
        editable={busy === null && localState !== 'loading'}
        label="Private note"
        multiline
        onChangeText={(value) => {
          setPrivateNote(value)
          edit()
        }}
        placeholder="Only ever visible on your own scorecard."
        value={privateNote}
      />

      {error ? <Problem>{error}</Problem> : null}
      {/* One primary action. Saving is a status, not a decision. */}
      <Action
        disabled={busy !== null || localState === 'loading'}
        label={busy === 'submit' ? 'Submitting…' : 'Submit scorecard'}
        onPress={prepareSubmission}
      />
      <View style={styles.saveRow}>
        <Meta>
          {busy === 'save'
            ? 'Saving…'
            : dirty
              ? 'Unsaved edits are encrypted on this phone.'
              : localState === 'restored'
                ? 'Recovered from this phone.'
                : 'Draft saved.'}
        </Meta>
        {dirty ? (
          <QuietAction
            disabled={busy !== null || localState === 'loading'}
            label="Save now"
            onPress={async () => { await save() }}
          />
        ) : null}
      </View>
    </Section>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return <View style={styles.panel}>{children}</View>
}

function Button({
  label,
  onPress,
  disabled = false,
  secondary = false,
}: {
  label: string
  onPress: () => void | Promise<void>
  disabled?: boolean
  secondary?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary ? styles.secondaryButton : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.buttonText, secondary ? styles.secondaryButtonText : null]}>{label}</Text>
    </Pressable>
  )
}

function reviewerPlatform(): ReviewerPlatform | null {
  if (Platform.OS === 'android') return 'android'
  if (Platform.OS === 'ios') return 'ios'
  return null
}

function notificationLabel(
  registration: NotificationState,
  serverStatus: 'not_registered' | 'active' | 'invalid' | undefined,
) {
  if (serverStatus === 'invalid') return 'Rejected by provider'
  if (registration.status === 'loading') return 'Checking'
  if (registration.status === 'not_granted') return 'Not allowed'
  if (registration.status === 'unavailable') return 'Unavailable'
  if (serverStatus === 'active') return 'Ready'
  return 'Ready to register'
}

function anchorText(criterion: Criterion, score: number) {
  if (score === 0) return criterion.anchors.zero
  if (score === 1) return criterion.anchors.one
  if (score === 2) return criterion.anchors.two
  if (score === 3) return criterion.anchors.three
  if (score === 4) return criterion.anchors.four
  return 'Choose a published score from 0 to 4.'
}

function submissionProblem(criteria: Criterion[], ratings: Rating[]) {
  if (ratings.length !== criteria.length) return 'Rate every assigned criterion before submitting.'
  for (const criterion of criteria) {
    const rating = ratings.find((candidate) => candidate.criterionId === criterion.id)
    if (!rating) return 'Rate every assigned criterion before submitting.'
    if (
      (rating.score === 0 || rating.score === 4) &&
      (!rating.evidenceNote || rating.evidenceNote.trim().length < 3)
    ) {
      return `${criterion.label}: add a short evidence note for a score of ${rating.score}.`
    }
  }
  return null
}

/** The few words inside the ring: what being on duty means right now. */
function dutyStateDetail(current: ReviewerNow) {
  if (current.reserve) {
    return current.reserve.status === 'paged' ? 'You have been paged' : 'On call'
  }
  return 'Waiting for a team'
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback)
}

const styles = StyleSheet.create({
  /* No border. Every other duty screen is content on the background; a boxed
     card was the last thing making judging feel like a different product. */
  panel: { marginTop: 8, gap: 16 },
  flex: { flex: 1 },
  headingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  eyebrow: { color: palette.judging, fontSize: 13, fontWeight: '600', letterSpacing: 0.6, marginBottom: 6 },
  heading: { color: palette.text, fontSize: 30, fontWeight: '600', letterSpacing: -0.8, lineHeight: 35 },
  reviewHeading: { gap: 4 },
  reviewTitle: { color: palette.text, fontSize: 30, fontWeight: '600', letterSpacing: -0.8, lineHeight: 36 },
  table: {
    color: palette.text,
    borderWidth: 1,
    borderColor: palette.strong,
    borderRadius: radius.tile,
    paddingHorizontal: 10,
    paddingVertical: 7,
    fontSize: 13,
  },
  body: { color: palette.muted, fontSize: 15, lineHeight: 22 },
  value: { color: palette.text, fontSize: 16, lineHeight: 22 },
  idea: { color: palette.text, fontSize: 18, lineHeight: 26 },
  question: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 8 },
  guidance: { color: palette.faint, fontSize: 13, lineHeight: 19 },
  meta: { color: palette.faint, fontSize: 13, lineHeight: 18 },
  label: { color: palette.faint, fontSize: 13 },
  error: { color: palette.urgent, fontSize: 14, lineHeight: 20 },
  details: { borderTopWidth: 1, borderTopColor: palette.tile },
  detailRow: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 20,
    borderBottomWidth: 1,
    borderBottomColor: palette.tile,
  },
  detailValue: { color: palette.muted, fontSize: 14, textAlign: 'right' },
  button: {
    minHeight: 48,
    borderRadius: radius.control,
    backgroundColor: palette.text,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    flexGrow: 1,
  },
  buttonText: { color: palette.background, fontSize: 15, fontWeight: '600' },
  secondaryButton: { backgroundColor: 'transparent', borderWidth: 1, borderColor: palette.strong },
  secondaryButtonText: { color: palette.text },
  disabled: { opacity: 0.5 },
  waiting: { gap: 10, paddingVertical: 8 },
  pauseNotice: {
    gap: 7,
    padding: 13,
    borderWidth: 1,
    borderColor: palette.urgent,
    borderRadius: radius.tile,
    backgroundColor: palette.tile,
  },
  pagePrompt: { gap: 14 },
  availabilityBlock: { gap: 10, paddingTop: 6 },
  rule: { height: 1, backgroundColor: palette.tile, marginVertical: 4 },
  scannerBlock: { gap: 12 },
  conflictBlock: {
    gap: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: palette.urgent,
    borderRadius: radius.tile,
  },
  textButton: { color: palette.muted, fontSize: 14, textDecorationLine: 'underline' },
  camera: { width: '100%', height: 330, borderRadius: radius.tile, overflow: 'hidden' },
  timer: { color: palette.text, fontSize: 26, marginTop: 8, fontVariant: ['tabular-nums'] },
  overdue: { color: palette.urgent, fontSize: 26, marginTop: 8, fontVariant: ['tabular-nums'] },
  workspace: { gap: 24 },
  section: { gap: 12, paddingTop: 8 },
  sectionTitle: { color: palette.text, fontSize: 20, fontWeight: '600', letterSpacing: -0.4, lineHeight: 25 },
  evidenceHeader: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 12,
  },
  evidenceRow: { borderTopWidth: 1, borderTopColor: palette.tile, paddingTop: 10, gap: 3 },
  criterion: { paddingTop: 18, gap: 10 },
  criterionLabel: { color: palette.text, fontSize: 19, fontWeight: '600', letterSpacing: -0.3 },
  criterionQuestion: { color: palette.muted, fontSize: 16, lineHeight: 22 },
  saveRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scoreRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  scoreButton: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: palette.strong,
    borderRadius: radius.control,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scoreSelected: { backgroundColor: palette.text, borderColor: palette.text },
  scoreText: { color: palette.muted, fontSize: 16 },
  scoreSelectedText: { color: palette.background, fontWeight: '700' },
  anchor: { minHeight: 40, color: palette.muted, fontSize: 15, lineHeight: 21 },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: palette.tile,
    borderRadius: radius.tile,
    color: palette.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: 'top',
    fontSize: 14,
    lineHeight: 20,
  },
  privateInput: { minHeight: 96 },
  shortInput: {
    width: 100,
    minHeight: 44,
    borderWidth: 1,
    borderColor: palette.tile,
    borderRadius: radius.tile,
    color: palette.text,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  codeInput: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: palette.tile,
    borderRadius: radius.tile,
    color: palette.text,
    paddingHorizontal: 12,
    fontFamily: 'monospace',
    fontSize: 17,
    letterSpacing: 1.5,
  },
  buttonRow: { flexDirection: 'row', gap: 10 },
})
