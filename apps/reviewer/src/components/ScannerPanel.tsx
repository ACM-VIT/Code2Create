import {
  barcodeSymbologies,
  findBarcodeSymbology,
  parseAttendanceQrPayload,
  type AttendanceQr,
  type BarcodeSymbology,
} from '@code2create/domain'
import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useAction, usePaginatedQuery, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { randomUUID } from 'expo-crypto'
import * as Network from 'expo-network'
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
  type BarcodeType,
} from 'expo-camera'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Stack, useLocalSearchParams, useRouter } from 'expo-router'

import { DutyIcon } from '@/components/DutyIcon'
import {
  AppState,
  Dimensions,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'

import {
  Action,
  Body,
  Card,
  Field,
  Heading,
  HeaderButton,
  Meta,
  Nothing,
  Problem,
  QuietAction,
  Row,
  ScanSurface,
  type ScanVerdict,
  Section,
  Sheet,
} from '@/components/ui'
import {
  clearScannerDevice,
  createScannerDevice,
  loadScannerDevice,
  reserveDeviceSequence,
  type ScannerDeviceRecord,
  type ScannerPlatform,
} from '@/lib/scanner-device'
import {
  clearPendingAttendanceScans,
  enqueuePendingAttendanceScan,
  loadPendingAttendanceScans,
  pendingAttendanceSummary,
  removePendingAttendanceScan,
  type PendingAttendanceSummary,
} from '@/lib/pending-attendance-scans'
import {
  allowedRovingTransitions,
  stationAcceptsCredential,
  type ScanTransition,
} from '@/lib/attendance-station-policy'
import { describeError, OperatorError } from '@/lib/errors'
import {
  runPersistentClientOperation,
  usePersistentClientOperations,
} from '@/lib/client-operation-intents'
import type { ReviewerRuntime } from '@/lib/runtime'
import { palette, radius } from '@/theme'
import { CaseListSkeleton, DoorSkeleton } from '@/components/skeletons'

type StationOption = FunctionReturnType<typeof api.attendanceScanner.availableStations>[number]
type ScannerAssignment = NonNullable<FunctionReturnType<typeof api.attendanceScanner.current>>
type ScanReceipt = FunctionReturnType<typeof api.attendanceActions.recordScan>
type StaffedParticipant = FunctionReturnType<
  typeof api.attendanceActions.resolveStaffedParticipant
>
type CredentialId = FunctionReturnType<
  typeof api.attendanceActions.beginVitBarcodeEnrollment
>['credentialId']
type VenueCheckInReceipt =
  | FunctionReturnType<typeof api.attendanceActions.recordVenueCheckIn>
  | FunctionReturnType<typeof api.attendanceActions.reverseVenueCheckIn>
type ActiveVenueCheckInView = {
  id: FunctionReturnType<typeof api.attendanceActions.recordVenueCheckIn>['checkInId']
  version: number
  checkedInAt: number
  stationName?: string
}
type ScanCredential =
  | AttendanceQr
  | { kind: 'vit_id_barcode'; rawBarcodeValue: string; symbology: BarcodeSymbology }
type DeviceReceipt = ScannerAssignment['recentReceipts'][number]
type DeviceState =
  | { status: 'loading' }
  | { status: 'ready'; record: ScannerDeviceRecord | null }
  | { status: 'error'; message: string }
type ScannerTask = 'presence' | 'staffed'
const staffedOperationSlots = [
  'attendance.badge.begin',
  'attendance.badge.revoke',
  'attendance.badge.verify',
  'attendance.venue.check-in',
  'attendance.venue.reverse',
  'attendance.vit.begin',
  'attendance.vit.suspend',
  'attendance.vit.verify',
] as const
type HeartbeatState =
  | { status: 'checking' }
  | { status: 'online' }
  | { status: 'error'; message: string }
type ServerClock = { serverNow: number; observedAt: number | null }
type CredentialSetupState =
  | { step: 'participant' }
  | { step: 'identity'; participant: StaffedParticipant }
  | { step: 'first_scan'; participant: StaffedParticipant }
  | {
      step: 'second_scan_ready'
      participant: StaffedParticipant
      credentialId: CredentialId
      badgeReference: string | null
    }

  | {
      step: 'second_scan'
      participant: StaffedParticipant
      credentialId: CredentialId
      badgeReference: string | null
    }
  | {
      step: 'complete'
      participant: StaffedParticipant
      outcome:
        | 'vit_enrolled'
        | 'vit_replaced'
        | 'vit_suspended'
        | 'badge_issued'
        | 'badge_replaced'
        | 'badge_revoked'
    }

function currentServerNow(clock: ServerClock) {
  return clock.observedAt === null
    ? clock.serverNow
    : clock.serverNow + performance.now() - clock.observedAt
}

function SetupFrame({ children }: { children: React.ReactNode }) {
  return (
    <ScrollView
      contentContainerStyle={styles.setupFrame}
      contentInsetAdjustmentBehavior="automatic"
    >
      {children}
    </ScrollView>
  )
}

export function ScannerPanel({ runtime }: { runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug
  const staffedOperations = usePersistentClientOperations(eventSlug, staffedOperationSlots)
  const platform = scannerPlatform()
  const [deviceState, setDeviceState] = useState<DeviceState>(() =>
    platform ? { status: 'loading' } : { status: 'ready', record: null },
  )
  const [registrationBusy, setRegistrationBusy] = useState(false)
  const [registrationError, setRegistrationError] = useState<string | null>(null)
  const availableStations = useQuery(api.attendanceScanner.availableStations, { eventSlug })
  const current = useQuery(
    api.attendanceScanner.current,
    deviceState.status === 'ready' && deviceState.record
      ? { eventSlug, installationId: deviceState.record.installationId }
      : 'skip',
  )
  const registerDevice = useAction(api.attendanceActions.registerDevice)

  useEffect(() => {
    if (!platform) return
    let active = true
    void loadScannerDevice(eventSlug)
      .then((record) => {
        if (active) setDeviceState({ status: 'ready', record })
      })
      .catch(() => {
        if (active) {
          setDeviceState({
            status: 'error',
            message: 'This phone cannot read its saved scanner setup.',
          })
        }
      })
    return () => {
      active = false
    }
  }, [eventSlug, platform])

  if (!platform) {
    return (
      <SetupFrame>
        <Section title="Attendance scanner">
          <Body>Open this duty on a provisioned Android phone or iPhone.</Body>
        </Section>
      </SetupFrame>
    )
  }
  if (deviceState.status === 'loading' || availableStations === undefined) {
    return <DoorSkeleton />
  }
  if (deviceState.status === 'error') {
    const clearBrokenSetup = async () => {
      if (registrationBusy) return
      setRegistrationBusy(true)
      setRegistrationError(null)
      try {
        await clearScannerDevice(eventSlug)
        setDeviceState({ status: 'ready', record: null })
      } catch {
        setRegistrationError('This phone could not clear its saved setup. Reinstall the reviewer app.')
      } finally {
        setRegistrationBusy(false)
      }
    }
    return (
      <SetupFrame>
        <Section title="Scanner setup needs attention">
          <Problem>{deviceState.message}</Problem>
          <Action
            accent={palette.door}
            disabled={registrationBusy}
            label={registrationBusy ? 'Resetting…' : 'Reset scanner setup'}
            onPress={clearBrokenSetup}
          />
          {registrationError ? <Problem>{registrationError}</Problem> : null}
        </Section>
      </SetupFrame>
    )
  }

  const register = async (record: ScannerDeviceRecord, station: StationOption) => {
    setRegistrationBusy(true)
    setRegistrationError(null)
    try {
      await registerDevice({
        eventSlug,
        stationId: station.id,
        expectedConfigurationVersion: station.configurationVersion,
        installationId: record.installationId,
        deviceSecret: record.deviceSecret,
        name: record.deviceName,
        platform: record.platform,
        reason: 'Provisioned by the signed-in station operator',
        clientOperationId: record.registrationOperationId,
      })
    } catch (error) {
      setRegistrationError(errorMessage(error, 'This phone could not be assigned.'))
    } finally {
      setRegistrationBusy(false)
    }
  }

  const provision = async (station: StationOption) => {
    setRegistrationBusy(true)
    setRegistrationError(null)
    try {
      const record = await createScannerDevice({
        eventSlug,
        stationStableKey: station.stableKey,
        platform,
      })
      setDeviceState({ status: 'ready', record })
      await register(record, station)
    } catch (error) {
      setRegistrationError(errorMessage(error, 'Scanner setup could not be saved.'))
      setRegistrationBusy(false)
    }
  }

  if (!deviceState.record) {
    return (
      <SetupFrame>
      <Section title="Assign this phone">
        {staffedOperations.records.size > 0 || staffedOperations.error ? (
          <Problem>{staffedOperations.error ?? 'Finish the saved credential action before assigning this phone again.'}</Problem>
        ) : null}
        {availableStations.length === 0 ? (
          <View style={styles.noStation}>
            <DutyIcon color={palette.door} name="door" size={40} />
            <Text style={styles.noStationTitle}>No station free</Text>
            <Text style={styles.noStationBody}>
              Every door station is already assigned. The door lead can release
              one for this phone.
            </Text>
          </View>
        ) : (
          availableStations.map((station) => (
            <Card
              key={station.id}
              {...(registrationBusy || staffedOperations.loading || staffedOperations.error !== null || staffedOperations.records.size > 0
                ? {}
                : { onPress: () => void provision(station) })}
            >
              <Heading>{station.name}</Heading>
              <Meta>{station.zoneName}</Meta>
            </Card>
          ))
        )}
        {registrationError ? <Problem>{registrationError}</Problem> : null}
      </Section>
      </SetupFrame>
    )
  }
  const deviceRecord = deviceState.record
  if (current === undefined) {
    return <DoorSkeleton />
  }
  if (!current) {
    const pendingStation = availableStations.find(
      (station) => station.stableKey === deviceRecord.stationStableKey,
    )
    const clearOldSetup = async () => {
      setRegistrationBusy(true)
      setRegistrationError(null)
      try {
        await clearPendingAttendanceScans({
          eventSlug,
          installationId: deviceRecord.installationId,
        })
        await clearScannerDevice(eventSlug)
        setDeviceState({ status: 'ready', record: null })
      } catch (error) {
        setRegistrationError(errorMessage(error, 'The old scanner setup could not be cleared.'))
      } finally {
        setRegistrationBusy(false)
      }
    }
    return (
      <SetupFrame>
      <Section title="Scanner setup is not active">
        <Body>
          {pendingStation
            ? `Retry ${pendingStation.name} if setup was interrupted, or clear the old setup after operations disabled it.`
            : 'The saved station is no longer available. Clear the old setup and any unsent scans before assigning this phone again.'}
        </Body>
        {staffedOperations.records.size > 0 || staffedOperations.error ? (
          <Problem>{staffedOperations.error ?? 'Finish the saved credential action before changing this phone setup.'}</Problem>
        ) : null}
        {pendingStation ? (
          <Action
            accent={palette.door}
            disabled={registrationBusy || staffedOperations.loading || staffedOperations.error !== null || staffedOperations.records.size > 0}
            label={registrationBusy ? 'Assigning…' : 'Retry assignment'}
            onPress={() => register(deviceRecord, pendingStation)}
          />
        ) : null}
        {!pendingStation ? (
          <QuietAction
            disabled={registrationBusy || staffedOperations.loading || staffedOperations.error !== null || staffedOperations.records.size > 0}
            label={registrationBusy ? 'Clearing…' : 'Clear old setup'}
            onPress={clearOldSetup}
          />
        ) : null}
        {registrationError ? <Problem>{registrationError}</Problem> : null}
      </Section>
      </SetupFrame>
    )
  }

  return (
    <ScannerSurface
      assignment={current}
      deviceRecord={deviceRecord}
      eventSlug={eventSlug}
      onDeviceRecord={(record) => setDeviceState({ status: 'ready', record })}
    />
  )
}

function ScannerSurface({
  assignment,
  deviceRecord,
  eventSlug,
  onDeviceRecord,
}: {
  assignment: ScannerAssignment
  deviceRecord: ScannerDeviceRecord
  eventSlug: string
  onDeviceRecord: (record: ScannerDeviceRecord) => void
}) {
  const staffedOperations = usePersistentClientOperations(eventSlug, staffedOperationSlots)
  const [permission, requestPermission] = useCameraPermissions()
  const recordScan = useAction(api.attendanceActions.recordScan)
  const scannerHeartbeat = useAction(api.attendanceActions.scannerHeartbeat)
  const resolveStaffedParticipant = useAction(
    api.attendanceActions.resolveStaffedParticipant,
  )
  const beginVitBarcodeEnrollment = useAction(
    api.attendanceActions.beginVitBarcodeEnrollment,
  )
  const verifyVitBarcodeEnrollment = useAction(
    api.attendanceActions.verifyVitBarcodeEnrollment,
  )
  const beginVitBarcodeRebind = useAction(api.attendanceActions.beginVitBarcodeRebind)
  const verifyVitBarcodeRebind = useAction(api.attendanceActions.verifyVitBarcodeRebind)
  const suspendVitBarcode = useAction(api.attendanceActions.suspendVitBarcode)
  const beginExternalBadgeIssue = useAction(api.attendanceActions.beginExternalBadgeIssue)
  const verifyExternalBadgeIssue = useAction(api.attendanceActions.verifyExternalBadgeIssue)
  const beginExternalBadgeReplacement = useAction(
    api.attendanceActions.beginExternalBadgeReplacement,
  )
  const verifyExternalBadgeReplacement = useAction(
    api.attendanceActions.verifyExternalBadgeReplacement,
  )
  const revokeExternalBadge = useAction(api.attendanceActions.revokeExternalBadge)
  const recordVenueCheckIn = useAction(api.attendanceActions.recordVenueCheckIn)
  const reverseVenueCheckIn = useAction(api.attendanceActions.reverseVenueCheckIn)
  const networkState = Network.useNetworkState()
  const busyRef = useRef(false)
  const replayingRef = useRef(false)
  const serverClockRef = useRef<ServerClock>({
    serverNow: assignment.serverNow,
    observedAt: null,
  })
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [replaying, setReplaying] = useState(false)
  const requestedTask = useLocalSearchParams<{ task?: string }>().task
  const [chosenTask, setChosenTask] = useState<ScannerTask>('presence')
  const task: ScannerTask =
    requestedTask === 'staffed' || requestedTask === 'presence' ? requestedTask : chosenTask
  const [credentialSetup, setCredentialSetup] = useState<CredentialSetupState>({
    step: 'participant',
  })
  const [credentialReason, setCredentialReason] = useState('')
  const [venueReason, setVenueReason] = useState('')
  const [venueCheckInReceipt, setVenueCheckInReceipt] =
    useState<VenueCheckInReceipt | null>(null)
  const [receipt, setReceipt] = useState<ScanReceipt | null>(null)
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null)
  const [pendingSummary, setPendingSummary] = useState<PendingAttendanceSummary>(() =>
    assignment.device.pendingReplayCount > 0 && assignment.device.oldestPendingCapturedAt
      ? {
          count: assignment.device.pendingReplayCount,
          oldestCapturedAt: assignment.device.oldestPendingCapturedAt,
        }
      : { count: 0 },
  )
  const [replayStatus, setReplayStatus] = useState<string | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [heartbeatState, setHeartbeatState] = useState<HeartbeatState>({
    status: 'checking',
  })
  const [appIsActive, setAppIsActive] = useState(AppState.currentState === 'active')
  const [pendingScan, setPendingScan] = useState<ScanCredential | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const staffedRecoveryLocked = staffedOperations.loading ||
    staffedOperations.error !== null ||
    staffedOperations.records.size > 0
  const deviceHistory = usePaginatedQuery(
    api.attendanceScanner.history,
    { eventSlug, installationId: deviceRecord.installationId },
    { initialNumItems: 25 },
  )
  const barcodeTypes = useMemo(() => scannerBarcodeTypes(), [])
  const rovingTransitions = allowedRovingTransitions({
    ...assignment.station,
    ...(assignment.openSession ? { openSessionId: assignment.openSession.id } : {}),
  })
  const definitelyOffline =
    networkState.isConnected === false || networkState.isInternetReachable === false
  const latestReplayReceipt = assignment.recentReceipts.find(
    (candidate) => candidate.isOfflineReplay,
  )

  useEffect(() => {
    serverClockRef.current = {
      serverNow: assignment.serverNow,
      observedAt: performance.now(),
    }
  }, [assignment.serverNow])

  const refreshPendingSummary = useCallback(async () => {
    const summary = await pendingAttendanceSummary({
      eventSlug,
      installationId: deviceRecord.installationId,
      now: currentServerNow(serverClockRef.current),
    })
    setPendingSummary(summary)
    return summary
  }, [deviceRecord.installationId, eventSlug])

  const replayPending = useCallback(async () => {
    if (replayingRef.current || busyRef.current) return
    replayingRef.current = true
    setReplaying(true)
    setReplayStatus(null)
    let synced = 0
    let rejected = 0
    try {
      const pending = await loadPendingAttendanceScans({
        eventSlug,
        installationId: deviceRecord.installationId,
        now: currentServerNow(serverClockRef.current),
      })
      for (const operation of pending) {
        if (operation.stationStableKey !== assignment.station.stableKey) {
          await removePendingAttendanceScan({
            eventSlug,
            installationId: deviceRecord.installationId,
            deviceSequence: operation.deviceSequence,
          })
          rejected += 1
          continue
        }
        try {
          await recordScan({
            eventSlug,
            stationId: assignment.station.id,
            expectedConfigurationVersion: operation.expectedConfigurationVersion,
            deviceInstallationId: assignment.device.id,
            deviceSecret: deviceRecord.deviceSecret,
            credential: operation.credential,
            ...(operation.rovingTransition !== undefined
              ? { rovingTransition: operation.rovingTransition }
              : {}),
            clientOperationId: operation.clientOperationId,
            deviceSequence: operation.deviceSequence,
            capturedAt: operation.capturedAt,
            isOfflineReplay: true,
          })
          await removePendingAttendanceScan({
            eventSlug,
            installationId: deviceRecord.installationId,
            deviceSequence: operation.deviceSequence,
          })
          synced += 1
        } catch (error) {
          if (!(error instanceof ConvexError)) {
            setHeartbeatState({
              status: 'error',
              message: 'Pending scans are still waiting to sync.',
            })
            break
          }
          await removePendingAttendanceScan({
            eventSlug,
            installationId: deviceRecord.installationId,
            deviceSequence: operation.deviceSequence,
          })
          rejected += 1
        }
      }
      const summary = await refreshPendingSummary()
      if (synced > 0 || rejected > 0) {
        setReplayStatus(
          [
            synced > 0 ? `${synced} pending ${synced === 1 ? 'scan' : 'scans'} synced` : null,
            rejected > 0
              ? `${rejected} ${rejected === 1 ? 'scan needs' : 'scans need'} staff follow-up`
              : null,
            summary.count > 0
              ? `${summary.count} still waiting on this phone`
              : null,
          ]
            .filter((part) => part !== null)
            .join(' · '),
        )
      }
    } catch (error) {
      setReplayStatus(errorMessage(error, 'The pending queue could not be opened.'))
    } finally {
      replayingRef.current = false
      setReplaying(false)
    }
  }, [
    assignment.device.id,
    assignment.station.id,
    assignment.station.stableKey,
    deviceRecord.deviceSecret,
    deviceRecord.installationId,
    eventSlug,
    recordScan,
    refreshPendingSummary,
  ])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setAppIsActive(state === 'active')
    })
    return () => subscription.remove()
  }, [])

  useEffect(() => {
    const subscription = Network.addNetworkStateListener((state) => {
      const canReachServer =
        state.isConnected === true && state.isInternetReachable !== false
      if (appIsActive && canReachServer) void replayPending()
    })
    return () => subscription.remove()
  }, [appIsActive, replayPending])

  useEffect(() => {
    if (!permission?.granted || !appIsActive) return
    let active = true
    let requestInFlight = false

    const heartbeat = async () => {
      if (requestInFlight) return
      requestInFlight = true
      try {
        const summary = await refreshPendingSummary()
        const result = await scannerHeartbeat({
          eventSlug,
          stationId: assignment.station.id,
          expectedConfigurationVersion: assignment.station.configurationVersion,
          deviceInstallationId: assignment.device.id,
          deviceSecret: deviceRecord.deviceSecret,
          pendingReplayCount: summary.count,
          ...(summary.oldestCapturedAt !== undefined
            ? { oldestPendingCapturedAt: summary.oldestCapturedAt }
            : {}),
        })
        serverClockRef.current = {
          serverNow: result.serverNow,
          observedAt: performance.now(),
        }
        if (active) {
          setHeartbeatState({ status: 'online' })
          if (summary.count > 0) void replayPending()
        }
      } catch (error) {
        if (active) {
          setHeartbeatState({
            status: 'error',
            message: errorMessage(error, 'Station heartbeat failed.'),
          })
        }
      } finally {
        requestInFlight = false
      }
    }

    void heartbeat()
    const interval = setInterval(() => void heartbeat(), 45_000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [
    assignment.device.id,
    assignment.station.configurationVersion,
    assignment.station.id,
    appIsActive,
    deviceRecord.deviceSecret,
    eventSlug,
    permission?.granted,
    refreshPendingSummary,
    replayPending,
    scannerHeartbeat,
  ])
  const displayedHeartbeatState: HeartbeatState =
    permission?.granted && appIsActive ? heartbeatState : { status: 'checking' }

  const handleBarcode = async (scan: BarcodeScanningResult) => {
    if (busyRef.current || replayingRef.current || receipt || pendingConfirmation) return
    busyRef.current = true
    setBusy(true)
    setScanError(null)
    try {
      if (task === 'staffed') {
        await handleCredentialBarcode(scan)
      } else {
        await handlePresenceBarcode(scan)
      }
    } catch (error) {
      setScanError(
        errorMessage(
          error,
          task === 'staffed'
            ? 'The staffed participant flow could not continue.'
            : 'The scan could not be recorded.',
        ),
      )
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handlePresenceBarcode = async (scan: BarcodeScanningResult) => {
    const parsedAttendanceQr = parseAttendanceQrPayload(scan.data)
    const symbology = findBarcodeSymbology(scan.type)
    const vitSymbology = parsedAttendanceQr ? null : allowedVitBarcode(symbology, assignment)
    const credential: ScanCredential | null =
      parsedAttendanceQr ??
      (vitSymbology
        ? { kind: 'vit_id_barcode', rawBarcodeValue: scan.data, symbology: vitSymbology }
        : null)
    if (!credential) {
      throw new OperatorError(unreadableCredential(symbology, assignment))
    }
    if (!stationAcceptsCredential(assignment.station.allowedCredentialKinds, credential.kind)) {
      throw new OperatorError(
        `${credentialName(credential.kind)} cannot be used at ${assignment.station.name}. Use a credential type assigned to this station.`,
      )
    }
    if (definitelyOffline && credential.kind === 'portal_qr') {
      throw new OperatorError('This phone is offline and cannot check a portal code. Use their ID card or badge instead.')
    }
    setPendingScan(credential)
  }

  const submitPendingScan = async (rovingTransition: ScanTransition | undefined) => {
    if (!pendingScan || busyRef.current || replayingRef.current) return
    busyRef.current = true
    setBusy(true)
    setScanError(null)
    const credential = pendingScan
    try {

    const reserved = await reserveDeviceSequence({
      eventSlug,
      record: deviceRecord,
      serverSequence: assignment.device.lastSequence,
    })
    onDeviceRecord(reserved)
    const capturedAt = Math.round(currentServerNow(serverClockRef.current))
    const clientOperationId = randomUUID()
    const queuedOperation = {
      eventSlug,
      installationId: reserved.installationId,
      stationStableKey: assignment.station.stableKey,
      expectedConfigurationVersion: assignment.station.configurationVersion,
      credential,
      ...(rovingTransition !== undefined ? { rovingTransition } : {}),
      clientOperationId,
      deviceSequence: reserved.lastIssuedSequence,
      capturedAt,
    }
    await enqueuePendingAttendanceScan({
      input: queuedOperation,
      maxScans: assignment.offlinePolicy.maxScans,
      maxAgeSeconds: assignment.offlinePolicy.maxAgeSeconds,
      now: capturedAt,
    })
    await refreshPendingSummary()
    if (definitelyOffline) {
      setPendingConfirmation('Saved on this phone. It is pending—not accepted—and will sync when the connection returns.')
      return
    }
    let result: ScanReceipt
    try {
      result = await recordScan({
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: reserved.deviceSecret,
        credential,
        ...(rovingTransition !== undefined ? { rovingTransition } : {}),
        clientOperationId,
        deviceSequence: reserved.lastIssuedSequence,
        capturedAt,
        isOfflineReplay: false,
      })
    } catch (error) {
      if (error instanceof ConvexError) {
        await removePendingAttendanceScan({
          eventSlug,
          installationId: reserved.installationId,
          deviceSequence: reserved.lastIssuedSequence,
        })
        await refreshPendingSummary()
        throw error
      }
      setHeartbeatState({ status: 'error', message: 'We could not confirm whether the scan was accepted.' })
      setPendingConfirmation('Saved on this phone. It is pending—not accepted—and will retry safely.')
      return
    }
    try {
      await removePendingAttendanceScan({
        eventSlug,
        installationId: reserved.installationId,
        deviceSequence: reserved.lastIssuedSequence,
      })
      await refreshPendingSummary()
    } catch (error) {
      setReplayStatus(errorMessage(error, 'The accepted scan will be cleared from the local queue on its idempotent retry.'))
    }
    setReceipt(result)
      setPendingScan(null)
    } catch (error) {
      setScanError(errorMessage(error, 'The scan could not be recorded.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleCredentialBarcode = async (scan: BarcodeScanningResult) => {
    if (credentialSetup.step === 'participant') {
      const participantQr = parseAttendanceQrPayload(scan.data)
      if (!participantQr || participantQr.kind !== 'portal_qr') {
        throw new OperatorError('Scan their portal QR first, then come back to this card.')
      }
      const participant = await resolveStaffedParticipant({
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        portalBearer: participantQr.bearer,
      })
      setVenueReason('')
      setVenueCheckInReceipt(null)
      setCredentialSetup({ step: 'identity', participant })
      return
    }
    if (credentialSetup.step !== 'first_scan' && credentialSetup.step !== 'second_scan') return
    const participant = credentialSetup.participant
    const credential = participant.credential
    if (credential.kind === 'badge_qr') {
      const badgeQr = parseAttendanceQrPayload(scan.data)
      if (!badgeQr || badgeQr.kind !== 'badge_qr') {
        throw new OperatorError('This needs the QR on their printed badge, not this code.')
      }
      if (credentialSetup.step === 'first_scan') {
        const result = credential.state === 'active'
          ? await runPersistentClientOperation({
              eventSlug,
              slot: 'attendance.badge.begin',
              fingerprint: operationFingerprint({
                eventSlug,
                stationId: assignment.station.id,
                expectedConfigurationVersion: assignment.station.configurationVersion,
                deviceInstallationId: assignment.device.id,
                deviceSecret: deviceRecord.deviceSecret,
                resolutionId: participant.resolutionId,
                membershipId: participant.membershipId,
                priorCredentialId: credential.credentialId,
                expectedPriorCredentialVersion: credential.expectedCredentialVersion,
                badgeBearer: badgeQr.bearer,
                visibleIdentityConfirmed: true,
                reason: credentialReason,
              }),
              execute: (clientOperationId) =>
                beginExternalBadgeReplacement({
                  clientOperationId,
                  eventSlug,
                  stationId: assignment.station.id,
                  expectedConfigurationVersion: assignment.station.configurationVersion,
                  deviceInstallationId: assignment.device.id,
                  deviceSecret: deviceRecord.deviceSecret,
                  resolutionId: participant.resolutionId,
                  membershipId: participant.membershipId,
                  priorCredentialId: credential.credentialId,
                  expectedPriorCredentialVersion: credential.expectedCredentialVersion,
                  badgeBearer: badgeQr.bearer,
                  visibleIdentityConfirmed: true,
                  reason: credentialReason,
                }),
            })
          : await runPersistentClientOperation({
              eventSlug,
              slot: 'attendance.badge.begin',
              fingerprint: operationFingerprint({
                eventSlug,
                stationId: assignment.station.id,
                expectedConfigurationVersion: assignment.station.configurationVersion,
                deviceInstallationId: assignment.device.id,
                deviceSecret: deviceRecord.deviceSecret,
                resolutionId: participant.resolutionId,
                membershipId: participant.membershipId,
                badgeBearer: badgeQr.bearer,
                visibleIdentityConfirmed: true,
              }),
              execute: (clientOperationId) =>
                beginExternalBadgeIssue({
                  clientOperationId,
                  eventSlug,
                  stationId: assignment.station.id,
                  expectedConfigurationVersion: assignment.station.configurationVersion,
                  deviceInstallationId: assignment.device.id,
                  deviceSecret: deviceRecord.deviceSecret,
                  resolutionId: participant.resolutionId,
                  membershipId: participant.membershipId,
                  badgeBearer: badgeQr.bearer,
                  visibleIdentityConfirmed: true,
                }),
            })
        setCredentialSetup({
          step: 'second_scan_ready',
          participant,
          credentialId: result.credentialId,
          badgeReference: result.badgeReference,
        })
        return
      }
      if (credential.state === 'active') {
        const request = {
          eventSlug,
          stationId: assignment.station.id,
          expectedConfigurationVersion: assignment.station.configurationVersion,
          deviceInstallationId: assignment.device.id,
          deviceSecret: deviceRecord.deviceSecret,
          resolutionId: participant.resolutionId,
          membershipId: participant.membershipId,
          priorCredentialId: credential.credentialId,
          expectedPriorCredentialVersion: credential.expectedCredentialVersion,
          replacementCredentialId: credentialSetup.credentialId,
          badgeBearer: badgeQr.bearer,
          reason: credentialReason,
        }
        await runPersistentClientOperation({
          eventSlug,
          slot: 'attendance.badge.verify',
          fingerprint: operationFingerprint(request),
          execute: (clientOperationId) =>
            verifyExternalBadgeReplacement({ ...request, clientOperationId }),
        })
      } else {
        const request = {
          eventSlug,
          stationId: assignment.station.id,
          expectedConfigurationVersion: assignment.station.configurationVersion,
          deviceInstallationId: assignment.device.id,
          deviceSecret: deviceRecord.deviceSecret,
          resolutionId: participant.resolutionId,
          membershipId: participant.membershipId,
          credentialId: credentialSetup.credentialId,
          badgeBearer: badgeQr.bearer,
        }
        await runPersistentClientOperation({
          eventSlug,
          slot: 'attendance.badge.verify',
          fingerprint: operationFingerprint(request),
          execute: (clientOperationId) =>
            verifyExternalBadgeIssue({ ...request, clientOperationId }),
        })
      }
      setCredentialSetup({
        step: 'complete',
        participant,
        outcome: credential.state === 'active' ? 'badge_replaced' : 'badge_issued',
      })
      return
    }
    if (parseAttendanceQrPayload(scan.data)) {
      throw new OperatorError('Scan the barcode printed on their VIT ID, not an event QR.')
    }
    const read = findBarcodeSymbology(scan.type)
    const symbology = allowedVitBarcode(read, assignment)
    if (!symbology) {
      throw new OperatorError(unreadableCredential(read, assignment))
    }
    if (credentialSetup.step === 'first_scan') {
      const replacing = credential.state === 'active' || credential.state === 'suspended'
      const result = replacing
        ? await runPersistentClientOperation({
            eventSlug,
            slot: 'attendance.vit.begin',
            fingerprint: operationFingerprint({
              eventSlug,
              stationId: assignment.station.id,
              expectedConfigurationVersion: assignment.station.configurationVersion,
              deviceInstallationId: assignment.device.id,
              deviceSecret: deviceRecord.deviceSecret,
              resolutionId: participant.resolutionId,
              membershipId: participant.membershipId,
              priorCredentialId: credential.credentialId,
              expectedPriorCredentialVersion: credential.expectedCredentialVersion,
              rawBarcodeValue: scan.data,
              symbology,
              visibleIdentityConfirmed: true,
              reason: credentialReason,
            }),
            execute: (clientOperationId) =>
              beginVitBarcodeRebind({
                clientOperationId,
                eventSlug,
                stationId: assignment.station.id,
                expectedConfigurationVersion: assignment.station.configurationVersion,
                deviceInstallationId: assignment.device.id,
                deviceSecret: deviceRecord.deviceSecret,
                resolutionId: participant.resolutionId,
                membershipId: participant.membershipId,
                priorCredentialId: credential.credentialId,
                expectedPriorCredentialVersion: credential.expectedCredentialVersion,
                rawBarcodeValue: scan.data,
                symbology,
                visibleIdentityConfirmed: true,
                reason: credentialReason,
              }),
          })
        : await runPersistentClientOperation({
            eventSlug,
            slot: 'attendance.vit.begin',
            fingerprint: operationFingerprint({
              eventSlug,
              stationId: assignment.station.id,
              expectedConfigurationVersion: assignment.station.configurationVersion,
              deviceInstallationId: assignment.device.id,
              deviceSecret: deviceRecord.deviceSecret,
              resolutionId: participant.resolutionId,
              membershipId: participant.membershipId,
              rawBarcodeValue: scan.data,
              symbology,
              visibleIdentityConfirmed: true,
            }),
            execute: (clientOperationId) =>
              beginVitBarcodeEnrollment({
                clientOperationId,
                eventSlug,
                stationId: assignment.station.id,
                expectedConfigurationVersion: assignment.station.configurationVersion,
                deviceInstallationId: assignment.device.id,
                deviceSecret: deviceRecord.deviceSecret,
                resolutionId: participant.resolutionId,
                membershipId: participant.membershipId,
                rawBarcodeValue: scan.data,
                symbology,
                visibleIdentityConfirmed: true,
              }),
          })
      setCredentialSetup({
        step: 'second_scan_ready',
        participant,
        credentialId: result.credentialId,
        badgeReference: null,
      })
      return
    }
    if (credential.state === 'active' || credential.state === 'suspended') {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        membershipId: participant.membershipId,
        priorCredentialId: credential.credentialId,
        expectedPriorCredentialVersion: credential.expectedCredentialVersion,
        replacementCredentialId: credentialSetup.credentialId,
        rawBarcodeValue: scan.data,
        symbology,
        reason: credentialReason,
      }
      await runPersistentClientOperation({
        eventSlug,
        slot: 'attendance.vit.verify',
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) => verifyVitBarcodeRebind({ ...request, clientOperationId }),
      })
    } else {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        credentialId: credentialSetup.credentialId,
        rawBarcodeValue: scan.data,
        symbology,
      }
      await runPersistentClientOperation({
        eventSlug,
        slot: 'attendance.vit.verify',
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) =>
          verifyVitBarcodeEnrollment({ ...request, clientOperationId }),
      })
    }
    setCredentialSetup({
      step: 'complete',
      participant,
      outcome:
        credential.state === 'active' || credential.state === 'suspended'
          ? 'vit_replaced'
          : 'vit_enrolled',
    })
  }

  const handleBadgeRevoke = async () => {
    if (busyRef.current || credentialSetup.step !== 'identity') return
    const participant = credentialSetup.participant
    const badgeSetup = participant.credential
    if (
      badgeSetup.kind !== 'badge_qr' ||
      badgeSetup.state !== 'active' ||
      !badgeSetup.canRevoke ||
      credentialReason.trim().length < 5
    ) return
    busyRef.current = true
    setBusy(true)
    setScanError(null)
    try {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        membershipId: participant.membershipId,
        credentialId: badgeSetup.credentialId,
        expectedCredentialVersion: badgeSetup.expectedCredentialVersion,
        visibleIdentityConfirmed: true,
        reason: credentialReason,
      }
      await runPersistentClientOperation({
        eventSlug,
        slot: 'attendance.badge.revoke',
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) => revokeExternalBadge({ ...request, clientOperationId }),
      })
      setCredentialSetup({ step: 'complete', participant, outcome: 'badge_revoked' })
    } catch (error) {
      setScanError(errorMessage(error, 'The event badge could not be revoked.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleVitSuspend = async () => {
    if (busyRef.current || credentialSetup.step !== 'identity') return
    const participant = credentialSetup.participant
    const setup = participant.credential
    if (
      setup.kind !== 'vit_id_barcode' ||
      setup.state !== 'active' ||
      !setup.canSuspend ||
      credentialReason.trim().length < 5
    ) return
    busyRef.current = true
    setBusy(true)
    setScanError(null)
    try {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        membershipId: participant.membershipId,
        credentialId: setup.credentialId,
        expectedCredentialVersion: setup.expectedCredentialVersion,
        visibleIdentityConfirmed: true,
        reason: credentialReason,
      }
      await runPersistentClientOperation({
        eventSlug,
        slot: 'attendance.vit.suspend',
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) => suspendVitBarcode({ ...request, clientOperationId }),
      })
      setCredentialSetup({ step: 'complete', participant, outcome: 'vit_suspended' })
    } catch (error) {
      setScanError(errorMessage(error, 'The VIT ID could not be suspended.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleVenueCheckIn = async (identityCheckKind: 'class_id' | 'approved_exception') => {
    if (
      busyRef.current ||
      venueCheckInReceipt !== null ||
      (credentialSetup.step !== 'identity' && credentialSetup.step !== 'complete')
    ) return
    const participant = credentialSetup.participant
    if (
      currentVenueCheckIn(participant, venueCheckInReceipt) ||
      (identityCheckKind === 'class_id' && !participant.canRecordVenueCheckIn) ||
      (identityCheckKind === 'approved_exception' &&
        (!participant.canOverrideVenueIdentity || venueReason.trim().length < 5))
    ) return
    busyRef.current = true
    setBusy(true)
    setScanError(null)
    try {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        identityCheckKind,
        visibleIdentityConfirmed: true,
        ...(identityCheckKind === 'approved_exception'
          ? { reason: venueReason }
          : {}),
      }
      const result = await runPersistentClientOperation({
        eventSlug,
        slot: 'attendance.venue.check-in',
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) => recordVenueCheckIn({ ...request, clientOperationId }),
      })
      setVenueCheckInReceipt(result)
      setVenueReason('')
    } catch (error) {
      setScanError(errorMessage(error, 'Venue check-in could not be recorded.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleVenueCheckInReversal = async () => {
    if (
      busyRef.current ||
      venueCheckInReceipt !== null ||
      venueReason.trim().length < 5 ||
      (credentialSetup.step !== 'identity' && credentialSetup.step !== 'complete')
    ) return
    const participant = credentialSetup.participant
    const activeCheckIn = currentVenueCheckIn(participant, venueCheckInReceipt)
    if (!activeCheckIn || !participant.canReverseVenueCheckIn) return
    busyRef.current = true
    setBusy(true)
    setScanError(null)
    try {
      const request = {
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        checkInId: activeCheckIn.id,
        expectedCheckInVersion: activeCheckIn.version,
        reason: venueReason,
      }
      const result = await runPersistentClientOperation({
        eventSlug,
        slot: 'attendance.venue.reverse',
        fingerprint: operationFingerprint(request),
        execute: (clientOperationId) => reverseVenueCheckIn({ ...request, clientOperationId }),
      })
      setVenueCheckInReceipt(result)
      setVenueReason('')
    } catch (error) {
      setScanError(errorMessage(error, 'Venue check-in could not be reversed.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const staffedVerdict: ScanVerdict | null = scanError
    ? { colour: palette.urgent, ink: palette.text, tone: 'no', detail: scanError }
    : busy
      ? { colour: palette.door, ink: palette.onDoor, tone: 'wait', detail: 'Checking…' }
      : null

  const startTask = (next: ScannerTask) => {
    if (staffedRecoveryLocked && !(task === 'presence' && next === 'staffed')) return
    setChosenTask(next)
    router.setParams({ task: next })
    setCredentialSetup({ step: 'participant' })
    setCredentialReason('')
    setVenueReason('')
    setVenueCheckInReceipt(null)
    setReceipt(null)
    setPendingConfirmation(null)
    setScanError(null)
  }

  if (!permission) {
    return (
      <SetupFrame>
        <Meta>Checking camera access…</Meta>
      </SetupFrame>
    )
  }
  if (!permission.granted) {
    return (
      <SetupFrame>
        <Section title="Camera access">
          <Body>The camera is used only to decode VIT ID barcodes and event QR codes.</Body>
          <Action
            accent={palette.door}
            label="Allow the camera"
            onPress={async () => {
              await requestPermission()
            }}
          />
        </Section>
      </SetupFrame>
    )
  }

  const presenceVerdict = receipt
    ? {
        colour: receipt.outcome === 'accepted' ? palette.judging : palette.urgent,
        ink: receipt.outcome === 'accepted' ? palette.onJudging : palette.text,
        tone: (receipt.outcome === 'accepted' ? 'ok' : 'no') as 'ok' | 'no',
        ...(receipt.participant ? { name: receipt.participant.displayName } : {}),
        ...(receipt.participant?.vitRegistrationNumber
          ? { registration: receipt.participant.vitRegistrationNumber }
          : {}),
        detail: reasonName(receipt.reasonCode),
      }
    : scanError
      ? { colour: palette.urgent, ink: palette.text, tone: 'no' as const, detail: scanError }
      : busy
        ? {
            colour: palette.door,
            ink: palette.onDoor,
            tone: 'wait' as const,
            detail: 'Checking this card…',
          }
        : pendingScan
          ? {
              colour: palette.door,
              ink: palette.onDoor,
              tone: 'ok' as const,
              detail:
                assignment.station.mode === 'roving'
                  ? 'Read. Choose the permitted movement below.'
                  : `Read. Confirm ${transitionName(assignment.station.mode).toLowerCase()} below.`,
            }
          : null

  if (task === 'presence') {
    return (
      <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton
              label="This door"
              onPress={() =>
                router.push({
                  pathname: '/duty/door-tools',
                  params: {
                    station: assignment.station.name,
                    zone: assignment.station.zoneName,
                    ...(assignment.openSession ? { session: assignment.openSession.name } : {}),
                    pending: String(assignment.device.pendingReplayCount),
                    sent: String(assignment.device.lastSequence),
                  },
                })
              }
            />
          ),
        }}
      />
      <ScanSurface
        camera={
          <CameraView
            barcodeScannerSettings={{ barcodeTypes }}
            facing="back"
            onBarcodeScanned={
              busy || replaying || receipt || pendingConfirmation || pendingScan
                ? undefined
                : handleBarcode
            }
            style={StyleSheet.absoluteFill}
          />
        }
        controls={
          <>
            <DirectionControl
              onChange={startTask}
              options={[
                ['presence', 'Presence'],
                ['staffed', 'Credentials'],
              ]}
              selected={task}
            />
            {staffedOperations.records.size > 0 ? (
              <Meta>Finish the earlier credential action with the exact same participant and card.</Meta>
            ) : null}
          </>
        }
        {...(presenceVerdict ? { verdict: presenceVerdict } : {})}
        result={
          <>
            {receipt || scanError ? (
              <>
                {receipt?.participant?.teamName ? (
                  <Meta>{receipt.participant.teamName}</Meta>
                ) : null}
                <Action
                  accent={palette.door}
                  label="Scan next"
                  onPress={() => {
                    setReceipt(null)
                    setScanError(null)
                    setPendingScan(null)
                  }}
                />
              </>
            ) : pendingScan ? (
              <>
                {assignment.station.mode === 'roving' ? (
                  rovingTransitions.map((option) => (
                    <Action
                      accent={palette.door}
                      key={option}
                      label={transitionName(option)}
                      onPress={() => void submitPendingScan(option)}
                    />
                  ))
                ) : (
                  <Action
                    accent={palette.door}
                    label={`Confirm ${transitionName(assignment.station.mode).toLowerCase()}`}
                    onPress={() => void submitPendingScan(undefined)}
                  />
                )}
                <Action
                  destructive
                  label="Cancel"
                  onPress={() => setPendingScan(null)}
                />
              </>
            ) : (
              <>
                {pendingSummary.count > 0 ? (
                  <Meta>
                    {pendingSummary.count} scan{pendingSummary.count === 1 ? '' : 's'} still to send
                  </Meta>
                ) : null}
                {replayStatus ? <Meta>{replayStatus}</Meta> : null}
                {latestReplayReceipt ? (
                  <Meta>
                    Sent late · {outcomeName(latestReplayReceipt.outcome)}
                    {latestReplayReceipt.participantName
                      ? ` · ${latestReplayReceipt.participantName}`
                      : ''}
                  </Meta>
                ) : null}
                <Row
                  {...(deviceHistory.results[0]
                    ? { detail: receiptLine(deviceHistory.results[0]) }
                    : {})}
                  label="Scan history"
                  onPress={() => setHistoryOpen(true)}
                />
              </>
            )}
          </>
        }
      />
      <Sheet
        detents={[0.45, 0.92]}
        onClose={() => setHistoryOpen(false)}
        title="Scan history"
        visible={historyOpen}
      >
        {deviceHistory.results.length === 0 ? (
          deviceHistory.status === 'LoadingFirstPage' ? (
            <CaseListSkeleton rows={4} />
          ) : (
            <Nothing>No receipts have come back to this phone yet.</Nothing>
          )
        ) : (
          <FlatList
            contentContainerStyle={styles.historyContent}
            data={deviceHistory.results}
            keyExtractor={(entry) => String(entry.deviceSequence)}
            onEndReached={() => {
              if (deviceHistory.status === 'CanLoadMore') deviceHistory.loadMore(50)
            }}
            onEndReachedThreshold={0.5}
            renderItem={({ item: entry }) => (
              <Row
                danger={entry.outcome === 'rejected' || entry.outcome === 'needs_review'}
                detail={receiptDetail(entry)}
                label={entry.participantName ?? outcomeName(entry.outcome)}
              />
            )}
            style={styles.historyList}
            {...(deviceHistory.status === 'LoadingMore'
              ? { ListFooterComponent: <CaseListSkeleton rows={2} /> }
              : {})}
          />
        )}
      </Sheet>
      </>
    )
  }

  const staffedCameraStep =
    credentialSetup.step === 'participant' ||
    credentialSetup.step === 'first_scan' ||
    credentialSetup.step === 'second_scan'
  if (!staffedCameraStep) {
    return (
      <ScrollView
        contentContainerStyle={styles.credentialPage}
        contentInsetAdjustmentBehavior="automatic"
      >
        {displayedHeartbeatState.status === 'error' ? (
          <Problem>{displayedHeartbeatState.message}</Problem>
        ) : null}
        <CredentialSetupInstructions
          credentialSetup={credentialSetup}
          reason={credentialReason}
          onReason={setCredentialReason}
          venueReason={venueReason}
          onVenueReason={setVenueReason}
          venueCheckInReceipt={venueCheckInReceipt}
          onVenueCheckIn={() => handleVenueCheckIn('class_id')}
          onVenueIdentityException={() => handleVenueCheckIn('approved_exception')}
          onVenueCheckInReversal={handleVenueCheckInReversal}
          onConfirmIdentity={() => {
            if (
              credentialSetup.step === 'identity' &&
              credentialCanStartScan(credentialSetup.participant, credentialReason)
            ) {
              setCredentialSetup({
                step: 'first_scan',
                participant: credentialSetup.participant,
              })
              setScanError(null)
            }
          }}
          onRevoke={handleBadgeRevoke}
          onSuspend={handleVitSuspend}
          onSecondScan={() => {
            if (credentialSetup.step === 'second_scan_ready') {
              setCredentialSetup({
                step: 'second_scan',
                participant: credentialSetup.participant,
                credentialId: credentialSetup.credentialId,
                badgeReference: credentialSetup.badgeReference,
              })
              setScanError(null)
            }
          }}
          onReset={() => {
            if (staffedRecoveryLocked) return
            setCredentialSetup({ step: 'participant' })
            setCredentialReason('')
            setVenueReason('')
            setVenueCheckInReceipt(null)
            setScanError(null)
          }}
          resetDisabled={staffedRecoveryLocked}
        />
        {scanError ? <Problem>{scanError}</Problem> : null}
        {scanError ? (
          <QuietAction label="Try again" onPress={() => setScanError(null)} />
        ) : null}
      </ScrollView>
    )
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton
              label="This door"
              onPress={() =>
                router.push({
                  pathname: '/duty/door-tools',
                  params: {
                    station: assignment.station.name,
                    zone: assignment.station.zoneName,
                    ...(assignment.openSession ? { session: assignment.openSession.name } : {}),
                    pending: String(assignment.device.pendingReplayCount),
                    sent: String(assignment.device.lastSequence),
                  },
                })
              }
            />
          ),
        }}
      />
      <ScanSurface
        camera={
          <CameraView
            barcodeScannerSettings={{ barcodeTypes }}
            facing="back"
            onBarcodeScanned={
              busy || replaying || !scannerReady(task, credentialSetup)
                ? undefined
                : handleBarcode
            }
            style={StyleSheet.absoluteFill}
          />
        }
        controls={
          <>
            <DirectionControl
              onChange={startTask}
              options={[
                ['presence', 'Presence'],
                ['staffed', 'Credentials'],
              ]}
              selected={task}
            />
            {staffedOperations.error ? <Problem>{staffedOperations.error}</Problem> : null}
            {staffedOperations.records.size > 0 ? (
              <Meta>Finish the earlier credential action before leaving this task.</Meta>
            ) : null}
          </>
        }
        {...(staffedVerdict ? { verdict: staffedVerdict } : {})}
        {...(credentialSetup.step === 'participant' &&
        !scanError &&
        displayedHeartbeatState.status !== 'error'
          ? {}
          : {
              result: (
          <ScrollView
            contentContainerStyle={styles.credentialDockContent}
            showsVerticalScrollIndicator={false}
            style={styles.credentialDock}
          >
            {displayedHeartbeatState.status === 'error' ? (
              <Problem>{displayedHeartbeatState.message}</Problem>
            ) : null}
            <CredentialSetupInstructions
              credentialSetup={credentialSetup}
              reason={credentialReason}
              onReason={setCredentialReason}
              venueReason={venueReason}
              onVenueReason={setVenueReason}
              venueCheckInReceipt={venueCheckInReceipt}
              onVenueCheckIn={() => handleVenueCheckIn('class_id')}
              onVenueIdentityException={() => handleVenueCheckIn('approved_exception')}
              onVenueCheckInReversal={handleVenueCheckInReversal}
              onConfirmIdentity={() => {}}
              onRevoke={handleBadgeRevoke}
              onSuspend={handleVitSuspend}
              onSecondScan={() => {}}
              onReset={() => {
                if (staffedRecoveryLocked) return
                setCredentialSetup({ step: 'participant' })
                setCredentialReason('')
                setVenueReason('')
                setVenueCheckInReceipt(null)
                setScanError(null)
              }}
              resetDisabled={staffedRecoveryLocked}
            />
            {scanError ? (
              <QuietAction label="Try again" onPress={() => setScanError(null)} />
            ) : null}
          </ScrollView>
              ),
            })}
      />
    </>
  )
}


function DirectionControl<Value extends string>({
  onChange,
  options,
  selected,
}: {
  onChange: (value: Value) => void
  options: readonly (readonly [Value, string])[]
  selected: Value
}) {
  return (
    <View style={styles.direction}>
      {options.map(([option, label]) => {
        const on = option === selected
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            key={option}
            onPress={() => onChange(option)}
            style={[styles.directionSegment, on ? styles.directionSegmentOn : null]}
          >
            <Text
              numberOfLines={1}
              style={[styles.directionLabel, on ? styles.directionLabelOn : null]}
            >
              {label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function CredentialSetupInstructions({
  credentialSetup,
  reason,
  onReason,
  venueReason,
  onVenueReason,
  venueCheckInReceipt,
  onVenueCheckIn,
  onVenueIdentityException,
  onVenueCheckInReversal,
  onConfirmIdentity,
  onRevoke,
  onSuspend,
  onSecondScan,
  onReset,
  resetDisabled,
}: {
  credentialSetup: CredentialSetupState
  reason: string
  onReason: (value: string) => void
  venueReason: string
  onVenueReason: (value: string) => void
  venueCheckInReceipt: VenueCheckInReceipt | null
  onVenueCheckIn: () => void | Promise<void>
  onVenueIdentityException: () => void | Promise<void>
  onVenueCheckInReversal: () => void | Promise<void>
  onConfirmIdentity: () => void
  onRevoke: () => void | Promise<void>
  onSuspend: () => void | Promise<void>
  onSecondScan: () => void
  onReset: () => void
  resetDisabled: boolean
}) {
  if (credentialSetup.step === 'participant') {
    return null
  }

  if (credentialSetup.step === 'identity') {
    const participant = credentialSetup.participant
    const credential = participant.credential
    const needsReason = credential.state === 'active' || credential.state === 'suspended'
    const canChangeCredential =
      (credential.kind === 'vit_id_barcode' && credential.state === 'not_enrolled'
        ? credential.canEnrol
        : credential.kind === 'vit_id_barcode'
          ? credential.canRebind
          : credential.state === 'not_issued'
            ? credential.canIssue
            : credential.canReplace)
    return (
      <>
        <Meta>Step 1 of 3 · Confirm who this is</Meta>
        <Heading>{participant.displayName}</Heading>
        {participant.vitRegistrationNumber ? (
          <Text style={styles.credentialRegistration}>{participant.vitRegistrationNumber}</Text>
        ) : null}
        <Meta>
          {participant.teamName} · {participant.institution}
        </Meta>
        {credential.kind === 'badge_qr' && credential.state === 'active' ? (
          <Meta>Active badge {credential.badgeReference}</Meta>
        ) : null}
        <Body>{identityInstruction(credential)}</Body>
        {needsReason ? (
          <Field
            label={
              credential.kind === 'vit_id_barcode'
                ? 'Why this ID binding is changing'
                : 'Why this badge is changing'
            }
            maxLength={300}
            multiline
            onChangeText={onReason}
            placeholder="Reason for operations"
            value={reason}
          />
        ) : null}
        {canChangeCredential ? (
          <Action
            accent={palette.door}
            disabled={needsReason && reason.trim().length < 5}
            label={credentialSetupActionLabel(credential)}
            onPress={onConfirmIdentity}
          />
        ) : null}
        {credential.kind === 'badge_qr' &&
        credential.state === 'active' &&
        credential.canRevoke ? (
          <QuietAction
            disabled={reason.trim().length < 5}
            label="Revoke active badge"
            onPress={onRevoke}
          />
        ) : null}
        {credential.kind === 'vit_id_barcode' &&
        credential.state === 'active' &&
        credential.canSuspend ? (
          <QuietAction
            disabled={reason.trim().length < 5}
            label="Suspend current VIT ID"
            onPress={onSuspend}
          />
        ) : null}
        <VenueCheckInControls
          participant={participant}
          receipt={venueCheckInReceipt}
          reason={venueReason}
          onReason={onVenueReason}
          onRecord={onVenueCheckIn}
          onException={onVenueIdentityException}
          onReverse={onVenueCheckInReversal}
        />
        <Action destructive disabled={resetDisabled} label="Cancel" onPress={onReset} />
      </>
    )
  }
  if (credentialSetup.step === 'first_scan') {
    return (
      <>
        <Meta>Step 2 of 3 · First scan</Meta>
        <Body>
          {credentialSetup.participant.credential.kind === 'badge_qr'
            ? 'Aim at the QR on the unused printed badge.'
            : 'Aim at the barcode printed on the VIT ID.'}
        </Body>
        <Action destructive disabled={resetDisabled} label="Cancel" onPress={onReset} />
      </>
    )
  }
  if (credentialSetup.step === 'second_scan_ready') {
    return (
      <>
        <Meta>Step 3 of 3 · Verify</Meta>
        {credentialSetup.badgeReference ? (
          <Heading>{credentialSetup.badgeReference}</Heading>
        ) : null}
        <Body>
          {credentialSetup.badgeReference
            ? 'Check this matches the printed badge. Move it away, then scan it once more.'
            : 'First scan matched. Move the card away, then scan it once more.'}
        </Body>
        <Action accent={palette.door} label="Start verification scan" onPress={onSecondScan} />
        <Action destructive disabled={resetDisabled} label="Cancel" onPress={onReset} />
      </>
    )
  }
  if (credentialSetup.step === 'second_scan') {
    return (
      <>
        <Meta>Step 3 of 3 · Verify</Meta>
        <Body>
          {credentialSetup.badgeReference
            ? `Scan badge ${credentialSetup.badgeReference} again.`
            : 'Scan the same VIT ID barcode again.'}
        </Body>
        <Action destructive disabled={resetDisabled} label="Cancel" onPress={onReset} />
      </>
    )
  }
  return (
    <>
      <Meta>Done</Meta>
      <Heading>{credentialSetupOutcomeLabel(credentialSetup.outcome)}</Heading>
      <Body>{credentialSetup.participant.displayName}</Body>
      <VenueCheckInControls
        participant={credentialSetup.participant}
        receipt={venueCheckInReceipt}
        reason={venueReason}
        onReason={onVenueReason}
        onRecord={onVenueCheckIn}
        onException={onVenueIdentityException}
        onReverse={onVenueCheckInReversal}
      />
      <Action accent={palette.door} disabled={resetDisabled} label="Set up next participant" onPress={onReset} />
    </>
  )
}

function identityInstruction(credential: StaffedParticipant['credential']) {
  if (credential.kind === 'vit_id_barcode') {
    if (credential.state === 'suspended') {
      return 'This VIT ID is suspended. Bind a different card with two matching scans.'
    }
    if (credential.state === 'active') {
      return 'A replacement takes two matching scans. The current card works until the new one verifies.'
    }
    return 'Check the VIT ID in their hand matches these details, then enrol its barcode.'
  }
  if (credential.state === 'not_issued') {
    return 'Check the person matches these details, then pick one unused printed badge.'
  }
  return 'Check the person matches these details before replacing or revoking their badge.'
}

function VenueCheckInControls({
  participant,
  receipt,
  reason,
  onReason,
  onRecord,
  onException,
  onReverse,
}: {
  participant: StaffedParticipant
  receipt: VenueCheckInReceipt | null
  reason: string
  onReason: (value: string) => void
  onRecord: () => void | Promise<void>
  onException: () => void | Promise<void>
  onReverse: () => void | Promise<void>
}) {
  const activeCheckIn = currentVenueCheckIn(participant, receipt)
  if (activeCheckIn) {
    return (
      <View style={styles.block}>
        <Body>Venue check-in recorded</Body>
        <Meta>
          {new Date(activeCheckIn.checkedInAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
          {activeCheckIn.stationName ? ` · ${activeCheckIn.stationName}` : ''}
        </Meta>
        {participant.canReverseVenueCheckIn && receipt === null ? (
          <>
            <Field
              label="Why this check-in is wrong"
              maxLength={300}
              multiline
              onChangeText={onReason}
              placeholder="Reason for operations"
              value={reason}
            />
            <QuietAction
              disabled={reason.trim().length < 5}
              label="Reverse check-in"
              onPress={onReverse}
            />
          </>
        ) : receipt?.status === 'checked_in' ? (
          <Meta>Scan a fresh portal QR to reverse this check-in.</Meta>
        ) : null}
      </View>
    )
  }
  if (receipt?.status === 'reversed') {
    return (
      <View style={styles.block}>
        <Body>Venue check-in reversed</Body>
        <Meta>Scan a fresh portal QR before recording another arrival.</Meta>
      </View>
    )
  }
  const wasReversed = participant.venueCheckIn?.status === 'reversed'
  if (!participant.canRecordVenueCheckIn && !participant.canOverrideVenueIdentity) {
    return (
      <View style={styles.block}>
        <Body>{wasReversed ? 'This check-in was reversed' : 'You cannot check people in'}</Body>
        <Meta>
          {wasReversed
            ? 'This phone cannot record a new one. A coordinator can.'
            : 'This phone does not have access to venue check-in. Ask a coordinator to do it or to give you access.'}
        </Meta>
      </View>
    )
  }
  return (
    <View style={styles.block}>
      <Body>{wasReversed ? 'Venue check-in was reversed' : 'Venue check-in'}</Body>
      <Meta>
        Confirm the visible {participant.participantClass === 'vit_student' ? 'VIT ID' : 'photo ID'} matches these details.
      </Meta>
      {participant.canRecordVenueCheckIn ? (
        <Action
          accent={palette.door}
          label={participant.participantClass === 'vit_student'
            ? 'Identity matches; check in'
            : 'Photo ID matches; check in'}
          onPress={onRecord}
        />
      ) : null}
      {participant.canOverrideVenueIdentity ? (
        <>
          <Field
            label="Approved no-ID exception"
            maxLength={300}
            multiline
            onChangeText={onReason}
            placeholder="Who approved it, and why"
            value={reason}
          />
          <QuietAction
            disabled={reason.trim().length < 5}
            label="Check in under approved exception"
            onPress={onException}
          />
        </>
      ) : null}
    </View>
  )
}

function currentVenueCheckIn(
  participant: StaffedParticipant,
  receipt: VenueCheckInReceipt | null,
): ActiveVenueCheckInView | null {
  if (receipt?.status === 'checked_in') {
    return {
      id: receipt.checkInId,
      version: receipt.version,
      checkedInAt: receipt.checkedInAt,
    }
  }
  if (receipt?.status === 'reversed') return null
  if (participant.venueCheckIn?.status !== 'checked_in') return null
  return {
    id: participant.venueCheckIn.id,
    version: participant.venueCheckIn.version,
    checkedInAt: participant.venueCheckIn.checkedInAt,
    stationName: participant.venueCheckIn.stationName,
  }
}

function credentialCanStartScan(participant: StaffedParticipant, reason: string) {
  const credential = participant.credential
  if (credential.kind === 'vit_id_barcode' && credential.state === 'not_enrolled') {
    return credential.canEnrol
  }
  if (credential.kind === 'badge_qr' && credential.state === 'not_issued') {
    return credential.canIssue
  }
  if (credential.kind === 'vit_id_barcode' && !credential.canRebind) return false
  if (credential.kind === 'badge_qr' && !credential.canReplace) return false
  return reason.trim().length >= 5
}

function credentialSetupActionLabel(credential: StaffedParticipant['credential']) {
  if (credential.kind === 'vit_id_barcode' && credential.state === 'not_enrolled') {
    return 'Enrol VIT ID barcode'
  }
  if (credential.kind === 'vit_id_barcode') return 'Replace VIT ID barcode'
  if (credential.state === 'not_issued') return 'Issue event badge'
  return 'Identity matches; replace badge'
}

function credentialSetupOutcomeLabel(outcome: Extract<CredentialSetupState, { step: 'complete' }>['outcome']) {
  if (outcome === 'vit_enrolled') return 'VIT ID enrolled'
  if (outcome === 'vit_replaced') return 'VIT ID replaced'
  if (outcome === 'vit_suspended') return 'VIT ID suspended'
  if (outcome === 'badge_issued') return 'Badge issued'
  if (outcome === 'badge_replaced') return 'Badge replaced'
  return 'Badge revoked'
}

function scannerReady(task: ScannerTask, credentialSetup: CredentialSetupState) {
  if (task === 'presence') return true
  return (
    credentialSetup.step === 'participant' ||
    credentialSetup.step === 'first_scan' ||
    credentialSetup.step === 'second_scan'
  )
}

function scannerPlatform(): ScannerPlatform | null {
  if (Platform.OS === 'android') return 'android'
  if (Platform.OS === 'ios') return 'ios'
  return null
}

// Detect every supported barcode, then enforce the station format after decoding.
function scannerBarcodeTypes() {
  return [...barcodeSymbologies] as BarcodeType[]
}

const symbologyNames: Record<BarcodeSymbology, string> = {
  aztec: 'Aztec',
  codabar: 'Codabar',
  code39: 'Code 39',
  code93: 'Code 93',
  code128: 'Code 128',
  datamatrix: 'Data Matrix',
  ean8: 'EAN-8',
  ean13: 'EAN-13',
  itf14: 'ITF-14',
  pdf417: 'PDF417',
  qr: 'QR',
  upc_a: 'UPC-A',
  upc_e: 'UPC-E',
}

function symbologyName(symbology: BarcodeSymbology) {
  return symbologyNames[symbology]
}

function unreadableCredential(
  symbology: BarcodeSymbology | null,
  assignment: ScannerAssignment,
) {
  if (symbology === null) return 'The scanner cannot read this kind of code. Try their event QR.'
  if (symbology === 'qr') return 'That QR code is not an event pass. Try their ID card instead.'
  const accepted = assignment.station.barcodeSymbologies
    .filter((allowed) => allowed !== 'qr')
    .map(symbologyName)
  const wanted =
    accepted.length === 0
      ? 'this door only takes event QR codes'
      : `this door reads ${listPhrase(accepted)}`
  return `That card is a ${symbologyName(symbology)} barcode, and ${wanted}. Check them in by hand and tell a coordinator.`
}

function listPhrase(items: string[]) {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function allowedVitBarcode(
  symbology: BarcodeSymbology | null,
  assignment: ScannerAssignment,
): BarcodeSymbology | null {
  return symbology &&
    assignment.station.barcodeSymbologies.some((allowed) => allowed === symbology)
    ? symbology
    : null
}

function credentialName(kind: ScanCredential['kind']) {
  if (kind === 'portal_qr') return 'A portal QR code'
  if (kind === 'badge_qr') return 'An event badge'
  return 'A VIT ID barcode'
}

function transitionName(transition: ScanTransition) {
  if (transition === 'venue_entry') return 'Arriving'
  if (transition === 'venue_exit') return 'Leaving'
  if (transition === 'session_confirm') return 'Session'
  if (transition === 'zone_entry') return 'Back in'
  return 'Stepped out'
}

function receiptLine(entry: DeviceReceipt) {
  return [entry.participantName ?? outcomeName(entry.outcome), receiptDetail(entry)].join(' · ')
}

function receiptDetail(entry: DeviceReceipt) {
  return [
    entry.participantName && entry.outcome !== 'accepted'
      ? outcomeName(entry.outcome)
      : null,
    transitionName(entry.transition),
    entry.isOfflineReplay ? 'replayed' : null,
    new Date(entry.capturedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  ]
    .filter((part) => part !== null)
    .join(' · ')
}

function outcomeName(outcome: ScanReceipt['outcome']) {
  if (outcome === 'accepted') return 'Recorded'
  if (outcome === 'duplicate') return 'Already recorded'
  if (outcome === 'needs_review') return 'Needs review'
  return 'Not recorded'
}

function reasonName(reason: string) {
  const names: Record<string, string> = {
    venue_entry_recorded: 'They’re in. Send them through.',
    venue_exit_recorded: 'Signed out. They can come back later.',
    session_presence_recorded: 'Marked present for this session.',
    temporary_exit_recorded: 'Stepped out. Scan them again on the way back.',
    already_inside: 'Already inside — no need to scan again.',
    already_outside: 'Already signed out.',
    already_present: 'Already marked present for this session.',
    already_temporarily_out: 'Already marked as stepped out.',
    credential_not_found:
      'This card is not registered yet. Send them to the help desk to get set up.',
    portal_qr_invalid: 'This code has expired. Ask them to refresh it in the portal.',
    portal_qr_used: 'This code has already been used. Ask them for a fresh one.',
    participant_not_active: 'They are not signed up for the event. Send them to the help desk.',
    participant_not_expected: 'They are not on the list for this session. Check with a coordinator.',
    session_not_open: 'No session is running here right now.',
    outside_check_in_window: 'Check-in for this session has closed.',
    offline_scan_needs_reconciliation:
      'Sent late, and no session was open at the time. Operations will sort it out — nothing more to do here.',
    offline_replay_conflicts_with_newer_state:
      'A later scan already counted. Operations will check this one — nothing more to do here.',
  }
  return names[reason] ?? 'Operations will review this one. Carry on.'
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback)
}

function operationFingerprint(value: object) {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('The client operation cannot be serialized.')
  return encoded
}

const styles = StyleSheet.create({
  noStation: { alignItems: 'center', gap: 8, paddingVertical: 36, paddingHorizontal: 24 },
  noStationTitle: {
    marginTop: 6,
    color: palette.text,
    fontSize: 19,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  noStationBody: {
    color: palette.muted,
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
  },
  credentialDock: { maxHeight: 400 },
  setupFrame: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 120, gap: 18 },
  credentialPage: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 120, gap: 12 },
  credentialDockContent: { gap: 12 },
  credentialRegistration: {
    color: palette.text,
    fontSize: 17,
    fontWeight: '600',
    letterSpacing: 2.2,
  },
  cameraFrame: { height: 300, overflow: 'hidden', backgroundColor: '#000' },
  cameraGuide: {
    position: 'absolute',
    top: 56,
    right: 40,
    bottom: 56,
    left: 40,
    borderWidth: 2,
    borderColor: palette.door,
  },

  block: { gap: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: palette.strong },

  // The SwiftUI host needs an explicit control height.
  direction: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    padding: 3,
    gap: 3,
    borderRadius: radius.control,
    backgroundColor: 'rgba(28,28,30,0.92)',
  },
  directionSegment: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.control,
  },
  directionSegmentOn: { backgroundColor: palette.door },
  directionLabel: { color: palette.text, fontSize: 15, fontWeight: '500' },
  directionLabelOn: { color: palette.onDoor, fontWeight: '600' },

  // Bound the list because the form sheet does not provide child height.
  historyList: { maxHeight: Math.round(Dimensions.get('window').height * 0.92) - 156 },
  historyContent: { gap: 8 },
})
