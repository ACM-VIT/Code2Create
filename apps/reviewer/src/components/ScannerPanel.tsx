import {
  findBarcodeSymbology,
  parseAttendanceQrPayload,
  type AttendanceQr,
  type BarcodeSymbology,
} from '@code2create/domain'
import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useAction, useQuery } from 'convex/react'
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
import { AppState, Platform, StyleSheet, View } from 'react-native'

import {
  Action,
  Body,
  Card,
  ChipRow,
  Field,
  Heading,
  Meta,
  Nothing,
  Problem,
  QuietAction,
  Section,
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
  type ScanTransition,
} from '@/lib/pending-attendance-scans'
import type { ReviewerRuntime } from '@/lib/runtime'
import { palette } from '@/theme'

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
type DeviceState =
  | { status: 'loading' }
  | { status: 'ready'; record: ScannerDeviceRecord | null }
  | { status: 'error'; message: string }
/** What this phone is being used for right now. Nothing to do with the station. */
type ScannerTask = 'presence' | 'staffed'
type HeartbeatState =
  | { status: 'checking' }
  | { status: 'online' }
  | { status: 'error'; message: string }
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

export function ScannerPanel({ runtime }: { runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug
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
      .catch((error: Error) => {
        if (active) setDeviceState({ status: 'error', message: error.message })
      })
    return () => {
      active = false
    }
  }, [eventSlug, platform])

  if (!platform) {
    return (
      <Section title="Attendance scanner">
        <Body>Open this duty on a provisioned Android phone or iPhone.</Body>
      </Section>
    )
  }
  if (deviceState.status === 'loading' || availableStations === undefined) {
    return <Meta>Loading the scanner setup…</Meta>
  }
  if (deviceState.status === 'error') {
    return (
      <Section title="Scanner setup needs attention">
        <Problem>{deviceState.message}</Problem>
      </Section>
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
      <Section lead="Choose the station this phone will operate." title="Assign this phone">
        {availableStations.length === 0 ? (
          <Nothing>No unassigned station is available to this account.</Nothing>
        ) : (
          availableStations.map((station) => (
            <Card
              key={station.id}
              {...(registrationBusy ? {} : { onPress: () => void provision(station) })}
            >
              <Heading>{station.name}</Heading>
              <Meta>{station.zoneName}</Meta>
            </Card>
          ))
        )}
        {registrationError ? <Problem>{registrationError}</Problem> : null}
      </Section>
    )
  }
  const deviceRecord = deviceState.record
  if (current === undefined) {
    return <Meta>Checking this phone’s station…</Meta>
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
      <Section title="Scanner setup is not active">
        <Body>
          {pendingStation
            ? `Retry ${pendingStation.name} if setup was interrupted, or clear the old setup after operations disabled it.`
            : 'The saved station is no longer available. Clear the old setup and any unsent scans before assigning this phone again.'}
        </Body>
        {pendingStation ? (
          <Action
            accent={palette.door}
            disabled={registrationBusy}
            label={registrationBusy ? 'Assigning…' : 'Retry assignment'}
            onPress={() => register(deviceRecord, pendingStation)}
          />
        ) : null}
        <QuietAction
          disabled={registrationBusy}
          label={registrationBusy ? 'Clearing…' : 'Clear old setup'}
          onPress={clearOldSetup}
        />
        {registrationError ? <Problem>{registrationError}</Problem> : null}
      </Section>
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
  const serverOffsetRef = useRef(0)
  const [busy, setBusy] = useState(false)
  const [replaying, setReplaying] = useState(false)
  const [task, setTask] = useState<ScannerTask>('presence')
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
  const [chosenTransition, setChosenTransition] = useState<ScanTransition | null>(null)
  const sessionIsOpen = assignment.openSession !== null
  const barcodeTypes = useMemo(
    () => scannerBarcodeTypes(assignment),
    [assignment],
  )
  const availableTransitions = useMemo(
    () => scanTransitions(sessionIsOpen),
    [sessionIsOpen],
  )
  /**
   * A door is a door: the same phone marks the person arriving or leaving, and
   * the direction rides on the scan rather than on how the station was set up.
   * Arriving is the default because it is the overwhelmingly common scan and
   * the only one that cannot be wrong at the start of a shift.
   */
  const transition: ScanTransition =
    chosenTransition && availableTransitions.includes(chosenTransition)
      ? chosenTransition
      : 'venue_entry'
  const definitelyOffline =
    networkState.isConnected === false || networkState.isInternetReachable === false
  const latestReplayReceipt = assignment.recentReceipts.find(
    (candidate) => candidate.isOfflineReplay,
  )

  useEffect(() => {
    serverOffsetRef.current = assignment.serverNow - Date.now()
  }, [assignment.serverNow])

  const refreshPendingSummary = useCallback(async () => {
    const summary = await pendingAttendanceSummary({
      eventSlug,
      installationId: deviceRecord.installationId,
      now: Date.now(),
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
        now: Date.now(),
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
            transition: operation.transition,
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
              message: 'Pending scans are still waiting for the server.',
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
        serverOffsetRef.current = result.serverNow - Date.now()
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
      throw new Error('This barcode format is not enabled for this station.')
    }
    if (definitelyOffline && credential.kind === 'portal_qr') {
      throw new Error('Participant portal codes need an online station. Use a VIT ID, event badge, or another phone.')
    }
    const reserved = await reserveDeviceSequence({
      eventSlug,
      record: deviceRecord,
      serverSequence: assignment.device.lastSequence,
    })
    onDeviceRecord(reserved)
    const capturedAt = Math.round(Date.now() + serverOffsetRef.current)
    const clientOperationId = randomUUID()
    // The direction is queued with the scan, so a replay records exactly what
    // the operator marked at the door rather than re-deciding it later.
    const queuedOperation = {
      eventSlug,
      installationId: reserved.installationId,
      stationStableKey: assignment.station.stableKey,
      expectedConfigurationVersion: assignment.station.configurationVersion,
      credential,
      transition,
      clientOperationId,
      deviceSequence: reserved.lastIssuedSequence,
      capturedAt,
    }
    await enqueuePendingAttendanceScan({
      input: queuedOperation,
      maxScans: assignment.offlinePolicy.maxScans,
      maxAgeSeconds: assignment.offlinePolicy.maxAgeSeconds,
      now: Date.now(),
    })
    await refreshPendingSummary()
    if (definitelyOffline) {
      setPendingConfirmation('Saved on this phone. It is pending—not accepted—and will replay when the server is reachable.')
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
        transition,
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
      setHeartbeatState({ status: 'error', message: 'The server response is uncertain.' })
      setPendingConfirmation('Saved on this phone. It is pending—not accepted—and will retry with the same operation ID.')
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
  }

  const handleCredentialBarcode = async (scan: BarcodeScanningResult) => {
    if (credentialSetup.step === 'participant') {
      const participantQr = parseAttendanceQrPayload(scan.data)
      if (!participantQr || participantQr.kind !== 'portal_qr') {
        throw new Error('Scan the participant’s current portal attendance QR first.')
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
        throw new Error('Scan the QR on the printed external-participant badge.')
      }
      if (credentialSetup.step === 'first_scan') {
        const result = credential.state === 'active'
          ? await beginExternalBadgeReplacement({
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
              clientOperationId: randomUUID(),
            })
          : await beginExternalBadgeIssue({
              eventSlug,
              stationId: assignment.station.id,
              expectedConfigurationVersion: assignment.station.configurationVersion,
              deviceInstallationId: assignment.device.id,
              deviceSecret: deviceRecord.deviceSecret,
              resolutionId: participant.resolutionId,
              membershipId: participant.membershipId,
              badgeBearer: badgeQr.bearer,
              visibleIdentityConfirmed: true,
              clientOperationId: randomUUID(),
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
        await verifyExternalBadgeReplacement({
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
          clientOperationId: randomUUID(),
        })
      } else {
        await verifyExternalBadgeIssue({
          eventSlug,
          stationId: assignment.station.id,
          expectedConfigurationVersion: assignment.station.configurationVersion,
          deviceInstallationId: assignment.device.id,
          deviceSecret: deviceRecord.deviceSecret,
          resolutionId: participant.resolutionId,
          membershipId: participant.membershipId,
          credentialId: credentialSetup.credentialId,
          badgeBearer: badgeQr.bearer,
          clientOperationId: randomUUID(),
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
      throw new Error('Scan the printed barcode on the VIT ID, not an event QR.')
    }
    const symbology = allowedVitBarcode(findBarcodeSymbology(scan.type), assignment)
    if (!symbology) {
      throw new Error('This VIT ID barcode format is not enabled for the event.')
    }
    if (credentialSetup.step === 'first_scan') {
      const result = credential.state === 'active' || credential.state === 'suspended'
        ? await beginVitBarcodeRebind({
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
            clientOperationId: randomUUID(),
          })
        : await beginVitBarcodeEnrollment({
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
            clientOperationId: randomUUID(),
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
      await verifyVitBarcodeRebind({
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
        clientOperationId: randomUUID(),
      })
    } else {
      await verifyVitBarcodeEnrollment({
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        credentialId: credentialSetup.credentialId,
        rawBarcodeValue: scan.data,
        symbology,
        clientOperationId: randomUUID(),
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
      await revokeExternalBadge({
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
        clientOperationId: randomUUID(),
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
      await suspendVitBarcode({
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
        clientOperationId: randomUUID(),
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
      const result = await recordVenueCheckIn({
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
        clientOperationId: randomUUID(),
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
      const result = await reverseVenueCheckIn({
        eventSlug,
        stationId: assignment.station.id,
        expectedConfigurationVersion: assignment.station.configurationVersion,
        deviceInstallationId: assignment.device.id,
        deviceSecret: deviceRecord.deviceSecret,
        resolutionId: participant.resolutionId,
        checkInId: activeCheckIn.id,
        expectedCheckInVersion: activeCheckIn.version,
        reason: venueReason,
        clientOperationId: randomUUID(),
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

  const startTask = (next: ScannerTask) => {
    setTask(next)
    setCredentialSetup({ step: 'participant' })
    setCredentialReason('')
    setVenueReason('')
    setVenueCheckInReceipt(null)
    setReceipt(null)
    setPendingConfirmation(null)
    setScanError(null)
  }

  if (!permission) return <Meta>Checking camera access…</Meta>
  if (!permission.granted) {
    return (
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
    )
  }

  return (
    <>
      <Card>
        <Heading>{assignment.station.name}</Heading>
        <Meta>
          {assignment.station.zoneName}
          {assignment.openSession ? ` · ${assignment.openSession.name}` : ''}
        </Meta>
        {displayedHeartbeatState.status === 'error' ? (
          <Problem>{displayedHeartbeatState.message}</Problem>
        ) : (
          <Meta>
            {displayedHeartbeatState.status === 'checking' ? 'Checking the connection…' : 'Online'}
          </Meta>
        )}
      </Card>

      <ChipRow
        accent={palette.door}
        onSelect={startTask}
        options={[
          ['presence', 'Record presence'],
          ['staffed', 'Arrival and credentials'],
        ]}
        selected={task}
      />

      {task === 'presence' ? (
        <>
          {/* One door, both directions. Marking the next scan is one tap and
              the sentence underneath says exactly what it will write. */}
          <ChipRow
            accent={palette.door}
            onSelect={(option) => {
              setChosenTransition(option)
              setScanError(null)
            }}
            options={availableTransitions.map(
              (option) => [option, transitionName(option)] as const,
            )}
            selected={transition}
          />
          <Meta>{transitionStatement(transition, assignment.openSession)}</Meta>
        </>
      ) : (
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
            setCredentialSetup({ step: 'participant' })
            setCredentialReason('')
            setVenueReason('')
            setVenueCheckInReceipt(null)
            setScanError(null)
          }}
        />
      )}

      {task === 'presence' && pendingSummary.count > 0 ? (
        <Section
          title={`${pendingSummary.count} pending ${pendingSummary.count === 1 ? 'scan' : 'scans'}`}
        >
          <Body>
            Encrypted on this phone. None is shown as accepted until the server returns a receipt.
          </Body>
          <QuietAction
            disabled={replaying || definitelyOffline}
            label={replaying ? 'Retrying…' : 'Retry now'}
            onPress={() => void replayPending()}
          />
        </Section>
      ) : null}
      {replayStatus ? <Meta>{replayStatus}</Meta> : null}
      {latestReplayReceipt ? (
        latestReplayReceipt.outcome === 'needs_review' ? (
          <Problem>
            Latest queued result · {outcomeName(latestReplayReceipt.outcome)}
            {latestReplayReceipt.participantName ? ` · ${latestReplayReceipt.participantName}` : ''}
          </Problem>
        ) : (
          <Meta>
            Latest queued result · {outcomeName(latestReplayReceipt.outcome)}
            {latestReplayReceipt.participantName ? ` · ${latestReplayReceipt.participantName}` : ''}
          </Meta>
        )
      ) : null}

      <View style={styles.cameraFrame}>
        <CameraView
          barcodeScannerSettings={{ barcodeTypes }}
          facing="back"
          onBarcodeScanned={
            busy ||
            replaying ||
            receipt ||
            pendingConfirmation ||
            !scannerReady(task, credentialSetup)
              ? undefined
              : handleBarcode
          }
          style={StyleSheet.absoluteFill}
        />
        <View pointerEvents="none" style={styles.cameraGuide} />
      </View>
      {busy ? <Meta>Checking…</Meta> : null}

      {task === 'presence' && receipt ? (
        <Section title={outcomeName(receipt.outcome)}>
          {receipt.participant ? (
            <>
              <Heading>{receipt.participant.displayName}</Heading>
              {receipt.participant.teamName ? <Meta>{receipt.participant.teamName}</Meta> : null}
            </>
          ) : null}
          {receipt.outcome === 'accepted' ? (
            <Body>{reasonName(receipt.reasonCode)}</Body>
          ) : (
            <Problem>{reasonName(receipt.reasonCode)}</Problem>
          )}
          <Action
            accent={palette.door}
            label="Scan next"
            onPress={() => {
              setReceipt(null)
              setScanError(null)
            }}
          />
        </Section>
      ) : null}
      {task === 'presence' && pendingConfirmation ? (
        <Section title="Pending">
          <Body>{pendingConfirmation}</Body>
          <Action
            accent={palette.door}
            label="Scan next"
            onPress={() => {
              setPendingConfirmation(null)
              setScanError(null)
            }}
          />
        </Section>
      ) : null}
      {scanError ? (
        <Section title="Not recorded">
          <Problem>{scanError}</Problem>
          <QuietAction label="Try again" onPress={() => setScanError(null)} />
        </Section>
      ) : null}
    </>
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
}) {
  if (credentialSetup.step === 'participant') {
    return <Body>Ask the participant to show their current portal attendance QR.</Body>
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
      <Card>
        <Heading>{participant.displayName}</Heading>
        <Meta>{participant.teamName} · {participant.institution}</Meta>
        {participant.vitRegistrationNumber ? (
          <Body>{participant.vitRegistrationNumber}</Body>
        ) : null}
        {credential.kind === 'badge_qr' && credential.state === 'active' ? (
          <Body>Active badge {credential.badgeReference}</Body>
        ) : null}
        <Body>
          {credential.kind === 'vit_id_barcode'
            ? credential.state === 'suspended'
              ? 'This VIT ID is suspended and cannot record attendance. Bind a different card with two matching scans.'
              : credential.state === 'active'
                ? 'The VIT ID barcode is active. A replacement takes two matching scans and leaves the current card active until verification.'
                : 'Compare these details with the visible VIT ID before enrolling its printed barcode.'
            : credential.state === 'not_issued'
                ? 'Confirm the participant matches these details, then choose one unused printed badge.'
                : 'Confirm the participant matches these details before replacing or revoking the active badge.'}
        </Body>
        {needsReason ? (
          <Field
            label={credential.kind === 'vit_id_barcode' ? 'Why this ID binding is changing' : 'Why this badge is changing'}
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
        <QuietAction label="Cancel" onPress={onReset} />
      </Card>
    )
  }
  if (credentialSetup.step === 'first_scan') {
    return (
      <Body>
        {credentialSetup.participant.credential.kind === 'badge_qr'
          ? 'Scan the QR on the unused printed badge.'
          : 'Scan the printed barcode on the VIT ID.'}
      </Body>
    )
  }
  if (credentialSetup.step === 'second_scan_ready') {
    return (
      <Card>
        {credentialSetup.badgeReference ? (
          <>
            <Meta>Printed reference</Meta>
            <Heading>{credentialSetup.badgeReference}</Heading>
          </>
        ) : null}
        <Body>
          {credentialSetup.badgeReference
            ? 'Check this matches the text on the physical badge. Move it away, then scan it once more.'
            : 'First scan matched. Move the card away, then verify it once more.'}
        </Body>
        <Action accent={palette.door} label="Start verification scan" onPress={onSecondScan} />
      </Card>
    )
  }
  if (credentialSetup.step === 'second_scan') {
    return (
      <Body>
        {credentialSetup.badgeReference
          ? `Scan badge ${credentialSetup.badgeReference} again.`
          : 'Scan the same VIT ID barcode again.'}
      </Body>
    )
  }
  return (
    <Card>
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
      <Action accent={palette.door} label="Set up next participant" onPress={onReset} />
    </Card>
  )
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
            <Meta>Presence scans and session attendance do not change.</Meta>
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
        <Meta>
          {wasReversed ? 'Venue check-in was reversed.' : 'Venue check-in not recorded.'}
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
      <Meta>This does not mark them inside or record session attendance.</Meta>
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

function scannerBarcodeTypes(assignment: ScannerAssignment) {
  const barcodeTypes: BarcodeType[] = [...assignment.station.barcodeSymbologies]
  if (!barcodeTypes.includes('qr')) barcodeTypes.push('qr')
  return barcodeTypes
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

/**
 * Every station can record every direction. The session transitions only appear
 * once a session is actually open in this area, because those are the only
 * moments the server can resolve one.
 */
function scanTransitions(sessionIsOpen: boolean): ScanTransition[] {
  return sessionIsOpen
    ? ['venue_entry', 'venue_exit', 'session_confirm', 'zone_entry', 'zone_exit']
    : ['venue_entry', 'venue_exit']
}

function transitionName(transition: ScanTransition) {
  if (transition === 'venue_entry') return 'Arriving'
  if (transition === 'venue_exit') return 'Leaving'
  if (transition === 'session_confirm') return 'Session'
  if (transition === 'zone_entry') return 'Back in'
  return 'Stepped out'
}

function transitionStatement(
  transition: ScanTransition,
  openSession: ScannerAssignment['openSession'],
) {
  if (transition === 'venue_entry') return 'The next scan marks them arriving at the venue.'
  if (transition === 'venue_exit') return 'The next scan marks them leaving the venue.'
  const session = openSession ? openSession.name : 'the open session'
  if (transition === 'session_confirm') return `The next scan confirms them present for ${session}.`
  if (transition === 'zone_entry') return `The next scan marks them back in ${session}.`
  return `The next scan marks them stepped out of ${session}.`
}

function outcomeName(outcome: ScanReceipt['outcome']) {
  if (outcome === 'accepted') return 'Recorded'
  if (outcome === 'duplicate') return 'Already recorded'
  if (outcome === 'needs_review') return 'Needs review'
  return 'Not recorded'
}

function reasonName(reason: string) {
  const names: Record<string, string> = {
    venue_entry_recorded: 'Venue entry recorded.',
    venue_exit_recorded: 'Venue exit recorded.',
    session_presence_recorded: 'Session presence recorded.',
    temporary_exit_recorded: 'Temporary exit recorded.',
    already_inside: 'This participant is already inside.',
    already_outside: 'This participant is already outside.',
    already_present: 'This participant is already present.',
    already_temporarily_out: 'This participant is already marked out.',
    credential_not_found: 'No active participant matches this credential.',
    portal_qr_invalid: 'This portal QR has expired or is invalid.',
    portal_qr_used: 'This portal QR has already been used.',
    participant_not_active: 'This participant is not active for the event.',
    participant_not_expected: 'This participant is not assigned to this session.',
    session_not_open: 'No session is open in this area right now.',
    outside_check_in_window: 'The session check-in window is closed.',
    offline_scan_needs_reconciliation: 'No session was open when this queued scan replayed. Operations will reconcile it.',
    offline_replay_conflicts_with_newer_state: 'A newer scan is already authoritative. Operations will review this queued scan.',
  }
  return names[reason] ?? 'The server recorded this result for operations review.'
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

const styles = StyleSheet.create({
  /* The viewfinder is the subject of the screen, so it gets real height and the
     guide is the only thing drawn over it. */
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

  /* A run of related controls inside a card, set off from the identity above. */
  block: { gap: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: palette.strong },
})
