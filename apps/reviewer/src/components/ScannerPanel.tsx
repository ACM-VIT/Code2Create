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
import { AppState, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

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
import type { ReviewerRuntime } from '@/lib/runtime'

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
type RovingTransition =
  | 'venue_entry'
  | 'venue_exit'
  | 'session_confirm'
  | 'zone_entry'
  | 'zone_exit'
type ScanCredential =
  | AttendanceQr
  | { kind: 'vit_id_barcode'; rawBarcodeValue: string; symbology: BarcodeSymbology }
type DeviceState =
  | { status: 'loading' }
  | { status: 'ready'; record: ScannerDeviceRecord | null }
  | { status: 'error'; message: string }
type ScannerMode = 'attendance' | 'staffed'
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
      <Panel>
        <Text style={styles.title}>Attendance scanner</Text>
        <Text style={styles.body}>Open this mode on a provisioned Android or iPhone.</Text>
      </Panel>
    )
  }
  if (deviceState.status === 'loading' || availableStations === undefined) {
    return (
      <Panel>
        <Text style={styles.body}>Loading scanner setup…</Text>
      </Panel>
    )
  }
  if (deviceState.status === 'error') {
    return (
      <Panel>
        <Text style={styles.title}>Scanner setup needs attention</Text>
        <Text style={styles.error}>{deviceState.message}</Text>
      </Panel>
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
      <Panel>
        <Text style={styles.title}>Assign this phone</Text>
        <Text style={styles.body}>Choose the station this phone will operate.</Text>
        {availableStations.length === 0 ? (
          <Text style={styles.muted}>No unassigned station is available to this account.</Text>
        ) : (
          availableStations.map((station) => (
            <StationButton
              key={station.id}
              station={station}
              disabled={registrationBusy}
              onPress={() => provision(station)}
            />
          ))
        )}
        {registrationError ? <Text style={styles.error}>{registrationError}</Text> : null}
      </Panel>
    )
  }
  const deviceRecord = deviceState.record
  if (current === undefined) {
    return (
      <Panel>
        <Text style={styles.body}>Checking this phone’s station…</Text>
      </Panel>
    )
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
      <Panel>
        <Text style={styles.title}>Scanner setup is not active</Text>
        <Text style={styles.body}>
          {pendingStation
            ? `Retry ${pendingStation.name} if setup was interrupted, or clear the old setup after operations disabled it.`
            : 'The saved station is no longer available. Clear the old setup and any unsent scans before assigning this phone again.'}
        </Text>
        <View style={styles.buttonStack}>
          {pendingStation ? (
            <Button
              label={registrationBusy ? 'Assigning…' : 'Retry assignment'}
              disabled={registrationBusy}
              onPress={() => register(deviceRecord, pendingStation)}
            />
          ) : null}
          <Button
            label={registrationBusy ? 'Clearing…' : 'Clear old setup'}
            disabled={registrationBusy}
            secondary
            onPress={clearOldSetup}
          />
        </View>
        {registrationError ? <Text style={styles.error}>{registrationError}</Text> : null}
      </Panel>
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
  const [mode, setMode] = useState<ScannerMode>('attendance')
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
  const [rovingTransition, setRovingTransition] = useState<RovingTransition | null>(null)
  const barcodeTypes = useMemo(
    () => scannerBarcodeTypes(assignment),
    [assignment],
  )
  const availableTransitions = useMemo(
    () => rovingTransitions(assignment),
    [assignment],
  )
  const staffedParticipantModeAvailable =
    assignment.station.mode === 'venue_entry' ||
    assignment.station.allowedCredentialKinds.some(
      (kind) => kind === 'vit_id_barcode' || kind === 'badge_qr',
    )
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
            ...(operation.rovingTransition
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
    if (mode === 'attendance' && assignment.station.mode === 'roving' && !rovingTransition) {
      setScanError('Choose what this station is recording before scanning.')
      return
    }
    busyRef.current = true
    setBusy(true)
    setScanError(null)
    try {
      if (mode === 'staffed') {
        await handleCredentialBarcode(scan)
      } else {
        await handleAttendanceBarcode(scan)
      }
    } catch (error) {
      setScanError(
        errorMessage(
          error,
          mode === 'staffed'
            ? 'The staffed participant flow could not continue.'
            : 'The scan could not be recorded.',
        ),
      )
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleAttendanceBarcode = async (scan: BarcodeScanningResult) => {
    const parsedAttendanceQr = parseAttendanceQrPayload(scan.data)
    if (
      parsedAttendanceQr &&
      !assignment.station.allowedCredentialKinds.some(
        (kind) => kind === parsedAttendanceQr.kind,
      )
    ) {
      throw new Error('This QR method is not enabled for this station.')
    }
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
    const queuedOperation = {
      eventSlug,
      installationId: reserved.installationId,
      stationStableKey: assignment.station.stableKey,
      expectedConfigurationVersion: assignment.station.configurationVersion,
      credential,
      ...(rovingTransition ? { rovingTransition } : {}),
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
        ...(rovingTransition ? { rovingTransition } : {}),
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

  if (!permission) {
    return (
      <Panel>
        <Text style={styles.body}>Checking camera access…</Text>
      </Panel>
    )
  }
  if (!permission.granted) {
    return (
      <Panel>
        <Text style={styles.title}>Camera access</Text>
        <Text style={styles.body}>The camera is used only to decode VIT ID barcodes and event QR codes.</Text>
        <Button
          label="Allow camera"
          onPress={async () => {
            await requestPermission()
          }}
        />
      </Panel>
    )
  }

  return (
    <View style={styles.scanner}>
      <View style={styles.stationHeader}>
        <View style={styles.grow}>
          <Text style={styles.title}>{assignment.station.name}</Text>
          <Text style={styles.muted}>
            {assignment.station.zoneName}
            {assignment.station.session ? ` · ${assignment.station.session.name}` : ''}
          </Text>
        </View>
        <Text style={displayedHeartbeatState.status === 'error' ? styles.error : styles.live}>
          {displayedHeartbeatState.status === 'checking'
            ? 'Checking'
            : displayedHeartbeatState.status === 'online'
              ? 'Online'
              : 'Connection issue'}
        </Text>
      </View>
      {displayedHeartbeatState.status === 'error' ? (
        <Text style={styles.error}>{displayedHeartbeatState.message}</Text>
      ) : null}
      {staffedParticipantModeAvailable ? (
        <View style={styles.modeRow}>
          <ModeButton
            label="Record presence"
            selected={mode === 'attendance'}
            onPress={() => {
              setMode('attendance')
              setCredentialSetup({ step: 'participant' })
              setCredentialReason('')
              setVenueReason('')
              setVenueCheckInReceipt(null)
              setReceipt(null)
              setPendingConfirmation(null)
              setScanError(null)
            }}
          />
          <ModeButton
            label={assignment.station.mode === 'venue_entry' ? 'Arrival desk' : 'Credential setup'}
            selected={mode === 'staffed'}
            onPress={() => {
              setMode('staffed')
              setCredentialSetup({ step: 'participant' })
              setCredentialReason('')
              setVenueReason('')
              setVenueCheckInReceipt(null)
              setReceipt(null)
              setPendingConfirmation(null)
              setScanError(null)
            }}
          />
        </View>
      ) : null}
      {mode === 'attendance' && assignment.station.mode === 'roving' ? (
        <View style={styles.transitionRow}>
          {availableTransitions.map((transition) => (
            <Pressable
              accessibilityRole="button"
              key={transition}
              onPress={() => {
                setRovingTransition(transition)
                setScanError(null)
              }}
              style={[
                styles.transition,
                rovingTransition === transition ? styles.transitionSelected : null,
              ]}
            >
              <Text
                style={[
                  styles.transitionText,
                  rovingTransition === transition ? styles.transitionTextSelected : null,
                ]}
              >
                {transitionName(transition)}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {mode === 'staffed' ? (
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
      ) : null}
      {mode === 'attendance' && pendingSummary.count > 0 ? (
        <View style={styles.pendingQueue}>
          <Text style={styles.receiptTitle}>
            {pendingSummary.count} pending {pendingSummary.count === 1 ? 'scan' : 'scans'}
          </Text>
          <Text style={styles.body}>Encrypted on this phone. None is shown as accepted until the server returns a receipt.</Text>
          <Button
            label={replaying ? 'Retrying…' : 'Retry now'}
            disabled={replaying || definitelyOffline}
            secondary
            onPress={() => void replayPending()}
          />
        </View>
      ) : null}
      {replayStatus ? <Text style={styles.muted}>{replayStatus}</Text> : null}
      {latestReplayReceipt ? (
        <Text style={latestReplayReceipt.outcome === 'needs_review' ? styles.error : styles.live}>
          Latest queued result · {outcomeName(latestReplayReceipt.outcome)}
          {latestReplayReceipt.participantName ? ` · ${latestReplayReceipt.participantName}` : ''}
        </Text>
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
            !scannerReady(mode, credentialSetup)
              ? undefined
              : handleBarcode
          }
          style={StyleSheet.absoluteFill}
        />
        <View pointerEvents="none" style={styles.guide} />
      </View>
      {busy ? <Text style={styles.body}>Checking…</Text> : null}
      {mode === 'attendance' && receipt ? (
        <View style={styles.receipt}>
          <Text style={receipt.outcome === 'accepted' ? styles.accepted : styles.receiptTitle}>
            {outcomeName(receipt.outcome)}
          </Text>
          {receipt.participant ? (
            <>
              <Text style={styles.participant}>{receipt.participant.displayName}</Text>
              {receipt.participant.teamName ? (
                <Text style={styles.muted}>{receipt.participant.teamName}</Text>
              ) : null}
            </>
          ) : null}
          <Text style={styles.body}>{reasonName(receipt.reasonCode)}</Text>
          <Button
            label="Scan next"
            onPress={() => {
              setReceipt(null)
              setScanError(null)
            }}
          />
        </View>
      ) : null}
      {mode === 'attendance' && pendingConfirmation ? (
        <View style={styles.receipt}>
          <Text style={styles.receiptTitle}>Pending</Text>
          <Text style={styles.body}>{pendingConfirmation}</Text>
          <Button
            label="Scan next"
            onPress={() => {
              setPendingConfirmation(null)
              setScanError(null)
            }}
          />
        </View>
      ) : null}
      {scanError ? (
        <View style={styles.receipt}>
          <Text style={styles.error}>{scanError}</Text>
          <Button label="Try again" onPress={() => setScanError(null)} />
        </View>
      ) : null}
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
    return (
      <Text style={styles.body}>
        Ask the participant to show their current portal attendance QR.
      </Text>
    )
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
      <View style={styles.identityCard}>
        <Text style={styles.participant}>{participant.displayName}</Text>
        <Text style={styles.muted}>{participant.teamName} · {participant.institution}</Text>
        {participant.vitRegistrationNumber ? (
          <Text style={styles.body}>{participant.vitRegistrationNumber}</Text>
        ) : null}
        {credential.kind === 'badge_qr' && credential.state === 'active' ? (
          <Text style={styles.body}>Active badge {credential.badgeReference}</Text>
        ) : null}
        <Text style={styles.body}>
          {credential.kind === 'vit_id_barcode'
            ? credential.state === 'suspended'
              ? 'This VIT ID is suspended and cannot record attendance. Bind a different card with two matching scans.'
              : credential.state === 'active'
                ? 'The VIT ID barcode is active. A replacement takes two matching scans and leaves the current card active until verification.'
                : 'Compare these details with the visible VIT ID before enrolling its printed barcode.'
            : credential.state === 'not_issued'
                ? 'Confirm the participant matches these details, then choose one unused printed badge.'
                : 'Confirm the participant matches these details before replacing or revoking the active badge.'}
        </Text>
        {needsReason ? (
          <TextInput
            accessibilityLabel="Reason for changing the attendance credential"
            maxLength={300}
            multiline
            onChangeText={onReason}
            placeholder={credential.kind === 'vit_id_barcode' ? 'Why is this ID binding changing?' : 'Why is this badge changing?'}
            placeholderTextColor="#625f5a"
            style={styles.reasonInput}
            value={reason}
          />
        ) : null}
        <View style={styles.buttonStack}>
          {canChangeCredential ? (
            <Button
              label={credentialSetupActionLabel(credential)}
              disabled={needsReason && reason.trim().length < 5}
              onPress={onConfirmIdentity}
            />
          ) : null}
          {credential.kind === 'badge_qr' &&
          credential.state === 'active' &&
          credential.canRevoke ? (
            <Button
              label="Revoke active badge"
              disabled={reason.trim().length < 5}
              onPress={onRevoke}
              secondary
            />
          ) : null}
          {credential.kind === 'vit_id_barcode' &&
          credential.state === 'active' &&
          credential.canSuspend ? (
            <Button
              label="Suspend current VIT ID"
              disabled={reason.trim().length < 5}
              onPress={onSuspend}
              secondary
            />
          ) : null}
        </View>
        <VenueCheckInControls
          participant={participant}
          receipt={venueCheckInReceipt}
          reason={venueReason}
          onReason={onVenueReason}
          onRecord={onVenueCheckIn}
          onException={onVenueIdentityException}
          onReverse={onVenueCheckInReversal}
        />
        <Button label="Cancel" onPress={onReset} secondary />
      </View>
    )
  }
  if (credentialSetup.step === 'first_scan') {
    return (
      <Text style={styles.body}>
        {credentialSetup.participant.credential.kind === 'badge_qr'
          ? 'Scan the QR on the unused printed badge.'
          : 'Scan the printed barcode on the VIT ID.'}
      </Text>
    )
  }
  if (credentialSetup.step === 'second_scan_ready') {
    return (
      <View style={styles.identityCard}>
        {credentialSetup.badgeReference ? (
          <>
            <Text style={styles.muted}>Printed reference</Text>
            <Text style={styles.participant}>{credentialSetup.badgeReference}</Text>
          </>
        ) : null}
        <Text style={styles.body}>
          {credentialSetup.badgeReference
            ? 'Check this matches the text on the physical badge. Move it away, then scan it once more.'
            : 'First scan matched. Move the card away, then verify it once more.'}
        </Text>
        <Button label="Start verification scan" onPress={onSecondScan} />
      </View>
    )
  }
  if (credentialSetup.step === 'second_scan') {
    return (
      <Text style={styles.body}>
        {credentialSetup.badgeReference
          ? `Scan badge ${credentialSetup.badgeReference} again.`
          : 'Scan the same VIT ID barcode again.'}
      </Text>
    )
  }
  return (
    <View style={styles.identityCard}>
      <Text style={styles.accepted}>{credentialSetupOutcomeLabel(credentialSetup.outcome)}</Text>
      <Text style={styles.participant}>{credentialSetup.participant.displayName}</Text>
      <VenueCheckInControls
        participant={credentialSetup.participant}
        receipt={venueCheckInReceipt}
        reason={venueReason}
        onReason={onVenueReason}
        onRecord={onVenueCheckIn}
        onException={onVenueIdentityException}
        onReverse={onVenueCheckInReversal}
      />
      <Button label="Set up next participant" onPress={onReset} />
    </View>
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
      <View style={styles.arrivalBlock}>
        <Text style={styles.accepted}>Venue check-in recorded</Text>
        <Text style={styles.muted}>
          {new Date(activeCheckIn.checkedInAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
          {activeCheckIn.stationName ? ` · ${activeCheckIn.stationName}` : ''}
        </Text>
        {participant.canReverseVenueCheckIn && receipt === null ? (
          <>
            <TextInput
              accessibilityLabel="Reason for reversing venue check-in"
              maxLength={300}
              multiline
              onChangeText={onReason}
              placeholder="Why is this check-in wrong?"
              placeholderTextColor="#625f5a"
              style={styles.reasonInput}
              value={reason}
            />
            <Button
              label="Reverse check-in"
              disabled={reason.trim().length < 5}
              onPress={onReverse}
              secondary
            />
            <Text style={styles.muted}>Presence scans and session attendance do not change.</Text>
          </>
        ) : receipt?.status === 'checked_in' ? (
          <Text style={styles.muted}>Scan a fresh portal QR to reverse this check-in.</Text>
        ) : null}
      </View>
    )
  }
  if (receipt?.status === 'reversed') {
    return (
      <View style={styles.arrivalBlock}>
        <Text style={styles.receiptTitle}>Venue check-in reversed</Text>
        <Text style={styles.muted}>Scan a fresh portal QR before recording another arrival.</Text>
      </View>
    )
  }
  const wasReversed =
    participant.venueCheckIn?.status === 'reversed'
  if (!participant.canRecordVenueCheckIn && !participant.canOverrideVenueIdentity) {
    return (
      <View style={styles.arrivalBlock}>
        <Text style={styles.muted}>
          {wasReversed ? 'Venue check-in was reversed.' : 'Venue check-in not recorded.'}
        </Text>
      </View>
    )
  }
  return (
    <View style={styles.arrivalBlock}>
      <Text style={styles.receiptTitle}>
        {wasReversed ? 'Venue check-in was reversed' : 'Venue check-in'}
      </Text>
      <Text style={styles.body}>
        Confirm the visible {participant.participantClass === 'vit_student' ? 'VIT ID' : 'photo ID'} matches these details.
      </Text>
      {participant.canRecordVenueCheckIn ? (
        <Button
          label={participant.participantClass === 'vit_student'
            ? 'Identity matches; check in'
            : 'Photo ID matches; check in'}
          onPress={onRecord}
        />
      ) : null}
      {participant.canOverrideVenueIdentity ? (
        <>
          <TextInput
            accessibilityLabel="Reason for approved identity exception"
            maxLength={300}
            multiline
            onChangeText={onReason}
            placeholder="Approved no-ID exception reason"
            placeholderTextColor="#625f5a"
            style={styles.reasonInput}
            value={reason}
          />
          <Button
            label="Check in under approved exception"
            disabled={reason.trim().length < 5}
            onPress={onException}
            secondary
          />
        </>
      ) : null}
      <Text style={styles.muted}>This does not mark them inside or record session attendance.</Text>
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

function scannerReady(mode: ScannerMode, credentialSetup: CredentialSetupState) {
  if (mode === 'attendance') return true
  return (
    credentialSetup.step === 'participant' ||
    credentialSetup.step === 'first_scan' ||
    credentialSetup.step === 'second_scan'
  )
}

function ModeButton({
  label,
  selected,
  onPress,
}: {
  label: string
  selected: boolean
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.modeButton, selected ? styles.modeButtonSelected : null]}
    >
      <Text style={[styles.modeButtonText, selected ? styles.modeButtonTextSelected : null]}>
        {label}
      </Text>
    </Pressable>
  )
}

function scannerPlatform(): ScannerPlatform | null {
  if (Platform.OS === 'android') return 'android'
  if (Platform.OS === 'ios') return 'ios'
  return null
}

function scannerBarcodeTypes(assignment: ScannerAssignment) {
  const barcodeTypes: BarcodeType[] = [...assignment.station.barcodeSymbologies]
  const usesQr = assignment.station.allowedCredentialKinds.some(
    (kind) => kind === 'badge_qr' || kind === 'portal_qr' || kind === 'vit_id_barcode',
  )
  if (usesQr && !barcodeTypes.includes('qr')) barcodeTypes.push('qr')
  return barcodeTypes
}

function allowedVitBarcode(
  symbology: BarcodeSymbology | null,
  assignment: ScannerAssignment,
): BarcodeSymbology | null {
  return (
    symbology &&
    assignment.station.allowedCredentialKinds.some((kind) => kind === 'vit_id_barcode') &&
    assignment.station.barcodeSymbologies.some((allowed) => allowed === symbology)
      ? symbology
      : null
  )
}

function rovingTransitions(assignment: ScannerAssignment): RovingTransition[] {
  return assignment.station.session
    ? ['session_confirm', 'zone_entry', 'zone_exit']
    : ['venue_entry', 'venue_exit']
}

function StationButton({
  station,
  disabled,
  onPress,
}: {
  station: StationOption
  disabled: boolean
  onPress: () => void | Promise<void>
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.stationButton, disabled ? styles.disabled : null]}
    >
      <Text style={styles.stationName}>{station.name}</Text>
      <Text style={styles.muted}>
        {station.zoneName}
        {station.session ? ` · ${station.session.name}` : ''}
      </Text>
    </Pressable>
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
      <Text style={[styles.buttonText, secondary ? styles.secondaryButtonText : null]}>
        {label}
      </Text>
    </Pressable>
  )
}

function transitionName(transition: RovingTransition) {
  if (transition === 'venue_entry') return 'Venue in'
  if (transition === 'venue_exit') return 'Venue out'
  if (transition === 'session_confirm') return 'Confirm'
  if (transition === 'zone_entry') return 'Return'
  return 'Exit'
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
    session_not_open: 'This session is not open.',
    outside_check_in_window: 'The session check-in window is closed.',
    offline_replay_conflicts_with_newer_state: 'A newer scan is already authoritative. Operations will review this queued scan.',
  }
  return names[reason] ?? 'The server recorded this result for operations review.'
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

const styles = StyleSheet.create({
  panel: {
    borderWidth: 1,
    borderColor: '#2c2a27',
    borderRadius: 8,
    padding: 18,
    gap: 12,
  },
  scanner: { gap: 14 },
  stationHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  grow: { flex: 1, gap: 3 },
  title: { color: '#f1eee8', fontFamily: 'Georgia', fontSize: 23, lineHeight: 29 },
  body: { color: '#aaa69f', fontSize: 15, lineHeight: 22 },
  muted: { color: '#77736d', fontSize: 13, lineHeight: 19 },
  error: { color: '#e3a4a4', fontSize: 14, lineHeight: 21 },
  live: { color: '#d6a0aa', fontSize: 13 },
  stationButton: {
    borderWidth: 1,
    borderColor: '#34322f',
    borderRadius: 7,
    padding: 14,
    gap: 4,
  },
  stationName: { color: '#f1eee8', fontSize: 16 },
  button: {
    minHeight: 46,
    borderRadius: 7,
    backgroundColor: '#eee9e0',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { color: '#11110f', fontSize: 15, fontWeight: '600' },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#34322f',
  },
  secondaryButtonText: { color: '#f1eee8' },
  buttonStack: { gap: 8 },
  disabled: { opacity: 0.5 },
  modeRow: { flexDirection: 'row', gap: 8 },
  modeButton: {
    flex: 1,
    minHeight: 42,
    borderWidth: 1,
    borderColor: '#34322f',
    borderRadius: 7,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 10,
  },
  modeButtonSelected: { backgroundColor: '#eee9e0', borderColor: '#eee9e0' },
  modeButtonText: { color: '#aaa69f', fontSize: 13 },
  modeButtonTextSelected: { color: '#11110f' },
  transitionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  transition: {
    borderWidth: 1,
    borderColor: '#34322f',
    borderRadius: 20,
    paddingHorizontal: 13,
    paddingVertical: 8,
  },
  transitionSelected: { backgroundColor: '#eee9e0', borderColor: '#eee9e0' },
  transitionText: { color: '#aaa69f', fontSize: 13 },
  transitionTextSelected: { color: '#11110f' },
  cameraFrame: {
    aspectRatio: 0.78,
    overflow: 'hidden',
    borderRadius: 8,
    backgroundColor: '#11110f',
  },
  guide: {
    position: 'absolute',
    left: 32,
    right: 32,
    top: '35%',
    height: 120,
    borderWidth: 1,
    borderColor: '#eee9e0',
    borderRadius: 8,
  },
  receipt: {
    borderWidth: 1,
    borderColor: '#34322f',
    borderRadius: 8,
    padding: 16,
    gap: 7,
  },
  pendingQueue: {
    borderWidth: 1,
    borderColor: '#5a5040',
    borderRadius: 8,
    padding: 14,
    gap: 8,
  },
  accepted: { color: '#b8c9ad', fontSize: 18, fontWeight: '600' },
  receiptTitle: { color: '#f1eee8', fontSize: 18, fontWeight: '600' },
  participant: { color: '#f1eee8', fontFamily: 'Georgia', fontSize: 25, lineHeight: 31 },
  identityCard: {
    gap: 9,
    padding: 14,
    borderWidth: 1,
    borderColor: '#34322f',
    borderRadius: 7,
  },
  arrivalBlock: {
    gap: 8,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#34322f',
  },
  reasonInput: {
    minHeight: 72,
    padding: 11,
    color: '#f1eee8',
    fontSize: 14,
    lineHeight: 20,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: '#34322f',
    borderRadius: 7,
  },
})
