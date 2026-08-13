import { api } from '@code2create/backend/api'
import {
  floorAreaAt,
  floorAreaLabels,
  floorMappingStateLabels,
  type FloorArea,
} from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { ConvexError } from 'convex/values'
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { useRef, useState } from 'react'
import { Stack } from 'expo-router'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'

import {
  Action,
  Body,
  ChipRow,
  Field,
  HeaderButton,
  Lead,
  Meta,
  Nothing,
  Problem,
  QuietAction,
  Row,
  Sheet,
  Viewfinder,
} from '@/components/ui'
import { describeError } from '@/lib/errors'
import {
  runPersistentClientOperation,
  usePersistentClientOperations,
} from '@/lib/client-operation-intents'
import type { ReviewerRuntime } from '@/lib/runtime'
import { palette, radius } from '@/theme'
import { HallSkeleton } from '@/components/skeletons'

type FloorClaim = FunctionReturnType<typeof api.floorMapping.claimTeamQr>
type FloorReceipt = FunctionReturnType<typeof api.floorMapping.assignClaim>
const floorOperationSlots = ['floor.claim', 'floor.assign'] as const

export function FloorMappingPanel({ runtime }: { runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug
  const floor = useQuery(api.floorMapping.available, { eventSlug })
  const claimTeamQr = useMutation(api.floorMapping.claimTeamQr)
  const assignClaim = useMutation(api.floorMapping.assignClaim)
  const [permission, requestPermission] = useCameraPermissions()
  const busyRef = useRef(false)
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null)
  const [manualCode, setManualCode] = useState('')
  const [picked, setPicked] = useState<{ x: number; y: number } | null>(null)
  const [showScanner, setShowScanner] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [findText, setFindText] = useState('')
  const [claim, setClaim] = useState<FloorClaim | null>(null)
  const [receipt, setReceipt] = useState<FloorReceipt | null>(null)
  const [overrideReason, setOverrideReason] = useState('Corrected after confirming the team’s physical location')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [claimUncertain, setClaimUncertain] = useState(false)
  const [assignmentUncertain, setAssignmentUncertain] = useState(false)
  const persistentOperations = usePersistentClientOperations(eventSlug, floorOperationSlots)
  const claimRecovery = persistentOperations.records.get('floor.claim')
  const assignmentRecovery = persistentOperations.records.get('floor.assign')?.recovery
  const recoveredAssignment = assignmentRecovery?.kind === 'floor_assignment_v1'
    ? assignmentRecovery
    : null
  const recoveryLocked = persistentOperations.loading ||
    persistentOperations.error !== null ||
    persistentOperations.records.size > 0

  if (floor === undefined) return <HallSkeleton />
  if (!floor) return <Body>There is no hall plan yet, so there is nothing to map.</Body>

  const selectedZone = floor.zones.find((zone) => zone.id === selectedZoneId) ?? floor.zones[0]
  if (!selectedZone) return <Body>No zone of the hall has been assigned to you.</Body>


  const claimCredential = async (credential: string) => {
    if (busyRef.current || claim || receipt) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const request = {
        eventSlug,
        destinationZoneId: selectedZone.id,
        credential,
      }
      const result = await runPersistentClientOperation({
        eventSlug,
        slot: 'floor.claim',
        fingerprint: JSON.stringify(request),
        execute: (clientOperationId) => claimTeamQr({ ...request, clientOperationId }),
      })
      setClaimUncertain(false)
      setClaim(result)
      setManualCode('')
      setShowScanner(false)
    } catch (caught) {
      setClaimUncertain(!(caught instanceof ConvexError))
      setError(errorMessage(caught, 'That team code could not be opened.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const handleBarcode = async (scan: BarcodeScanningResult) => {
    if (!scan.data.startsWith('c2c-floor-v1.')) {
      setError('Scan the hall-location QR shown in the team’s portal.')
      return
    }
    await claimCredential(scan.data)
  }

  const assignAt = async (point: { x: number; y: number }) => {
    if (!claim || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const request = {
        eventSlug,
        claimId: claim.id,
        x: point.x,
        y: point.y,
        expectedClaimVersion: claim.version,
        ...(claim.mode === 'override' ? { reason: overrideReason } : {}),
      }
      const result = await runPersistentClientOperation({
        eventSlug,
        slot: 'floor.assign',
        fingerprint: JSON.stringify(request),
        recovery: {
          kind: 'floor_assignment_v1',
          claimId: claim.id,
          x: point.x,
          y: point.y,
          expectedClaimVersion: claim.version,
          requiresReason: claim.mode === 'override',
        },
        execute: (clientOperationId) => assignClaim({ ...request, clientOperationId }),
      })
      setAssignmentUncertain(false)
      setReceipt(result)
      setClaim(null)
    } catch (caught) {
      setAssignmentUncertain(!(caught instanceof ConvexError))
      setError(errorMessage(caught, 'That location could not be saved.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const reset = () => {
    if (claimUncertain || assignmentUncertain || recoveryLocked) return
    setClaim(null)
    setReceipt(null)
    setError(null)
    setManualCode('')
    setPicked(null)
  }

  const placing = claim
  const areaName = picked ? floorAreaLabels[floorAreaAt(picked.x, picked.y)] : null

  const recorded =
    placing?.currentLocation && placing.currentLocation.zoneId === selectedZone.id
      ? { x: placing.currentLocation.x, y: placing.currentLocation.y }
      : null

  const query = findText.trim().toLowerCase()
  const placements = floor.zones
    .flatMap((zone) => zone.teams.map((team) => ({ ...team, zoneName: zone.name })))
    .filter((placement) => !query || placement.teamName.toLowerCase().includes(query))
    .sort((a, b) => b.mappedAt - a.mappedAt)
    .slice(0, 5)

  const placeHere = async () => {
    if (!picked) return
    await assignAt(picked)
    setPicked(null)
  }

  const retryRecoveredAssignment = async () => {
    if (!recoveredAssignment || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const request = {
        eventSlug,
        claimId: recoveredAssignment.claimId as FloorClaim['id'],
        x: recoveredAssignment.x,
        y: recoveredAssignment.y,
        expectedClaimVersion: recoveredAssignment.expectedClaimVersion,
        ...(recoveredAssignment.requiresReason ? { reason: overrideReason } : {}),
      }
      const result = await runPersistentClientOperation({
        eventSlug,
        slot: 'floor.assign',
        fingerprint: JSON.stringify(request),
        recovery: recoveredAssignment,
        execute: (clientOperationId) => assignClaim({ ...request, clientOperationId }),
      })
      setAssignmentUncertain(false)
      setReceipt(result)
    } catch (caught) {
      setAssignmentUncertain(!(caught instanceof ConvexError))
      setError(errorMessage(caught, 'That earlier location could not be confirmed.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  return (
    <View style={styles.frame}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton label="Hall tools" onPress={() => setShowTools(true)} />
          ),
        }}
      />

      <View style={styles.headline}>
        <Lead
          accent={palette.hall}
          {...(floor.plan.mappingState === 'frozen'
            ? { detail: floorMappingStateLabels.frozen }
            : floor.zones.length > 1
              ? { detail: `${floor.zones.length} assigned zones` }
              : {})}
          unit={selectedZone.teams.length === 1 ? 'team placed' : 'teams placed'}
          value={String(selectedZone.teams.length)}
        />
      </View>

      <View style={styles.canvasFrame}>
        <HallCanvas
          areas={selectedZone.areas}
          landmarks={selectedZone.landmarks}
          onPick={(point) => {
            if (assignmentUncertain) return
            setError(null)
            setPicked(point)
          }}
          picked={picked}
          placing={placing !== null}
          recorded={recorded}
          teams={selectedZone.teams}
        />
      </View>

      <View style={styles.dock}>
        {floor.zones.length > 1 ? (
          <ChipRow
            accent={palette.hall}
            onSelect={(zoneId) => {
              if (claimUncertain || assignmentUncertain || recoveryLocked) return
              setSelectedZoneId(zoneId)
              setPicked(null)
            }}
            options={floor.zones.map((zone) => [zone.id, zone.name] as const)}
            selected={selectedZone.id}
          />
        ) : null}

        {areaName ? <Meta>{areaName} of {selectedZone.name}</Meta> : null}
        {persistentOperations.error ? <Problem>{persistentOperations.error}</Problem> : null}
        {error ? <Problem>{error}</Problem> : null}

        {recoveredAssignment ? (
          <>
            <Meta>An earlier location is waiting for confirmation after this phone lost the response.</Meta>
            {recoveredAssignment.requiresReason ? (
              <Field
                label="Enter the exact earlier override reason"
                multiline
                onChangeText={setOverrideReason}
                placeholder="Use the same reason as before."
                value={overrideReason}
              />
            ) : null}
            <Action
              accent={palette.hall}
              disabled={busy || (recoveredAssignment.requiresReason && overrideReason.trim().length < 5)}
              label="Confirm earlier location"
              onPress={retryRecoveredAssignment}
            />
          </>
        ) : placing ? (
          <>
            {placing.currentLocation ? (
              <Meta>Currently in the {placing.currentLocation.description}.</Meta>
            ) : null}
            {placing.mode === 'override' ? (
              <Field
                label="Why is this frozen location changing?"
                multiline
                editable={!assignmentUncertain}
                onChangeText={setOverrideReason}
                placeholder="What you saw."
                value={overrideReason}
              />
            ) : null}
            <Action
              accent={palette.hall}
              disabled={
                busy ||
                !picked ||
                (placing.mode === 'override' && overrideReason.trim().length < 5)
              }
              label={
                assignmentUncertain
                  ? 'Confirm this location'
                  : picked
                  ? `Put ${placing.team.name} here`
                  : `Touch the room for ${placing.team.name}`
              }
              onPress={placeHere}
            />
            <QuietAction
              disabled={busy || assignmentUncertain}
              label="Scan a different team"
              onPress={reset}
            />
            {assignmentUncertain ? <Meta>Confirm the earlier location before choosing another.</Meta> : null}
          </>
        ) : receipt ? (
          <>
            <Meta>
              {receipt.teamName} is {receipt.unchanged ? 'still ' : ''}in the {receipt.description}.
            </Meta>
            <Action accent={palette.hall} disabled={recoveryLocked} label="Place the next team" onPress={reset} />
          </>
        ) : (
          <Action
            accent={palette.hall}
            label={claimRecovery ? 'Confirm earlier team scan' : 'Scan a team to place'}
            onPress={() => setShowScanner(true)}
          />
        )}
      </View>

      <Sheet
        detents={['auto']}
        onClose={() => {
          if (!claimUncertain && !claimRecovery) setShowScanner(false)
        }}
        title="Scan a team"
        visible={showScanner}
      >
        {!permission ? <Meta>Checking camera access…</Meta> : null}
        {permission && !permission.granted ? (
          <Action
            accent={palette.hall}
            label="Allow the camera"
            onPress={async () => {
              await requestPermission()
            }}
          />
        ) : null}
        {permission?.granted ? (
          <Viewfinder>
            <CameraView
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              facing="back"
              onBarcodeScanned={busy ? undefined : handleBarcode}
              style={StyleSheet.absoluteFill}
            />
          </Viewfinder>
        ) : null}
        <View style={styles.manualRow}>
          <TextInput
            autoCapitalize="characters"
            editable={!busy}
            onChangeText={setManualCode}
            numberOfLines={1}
            placeholder="Team code"
            placeholderTextColor={palette.faint}
            style={styles.input}
            value={manualCode}
          />
          <Pressable
            accessibilityRole="button"
            disabled={busy || manualCode.trim().length < 10}
            onPress={() => void claimCredential(manualCode)}
            style={[
              styles.openButton,
              busy || manualCode.trim().length < 10 ? styles.disabled : null,
            ]}
          >
            <Text
              style={[
                styles.openButtonText,
                busy || manualCode.trim().length < 10 ? styles.disabledText : null,
              ]}
            >
              {busy ? '…' : claimUncertain ? 'Retry' : 'Open'}
            </Text>
          </Pressable>
        </View>
        {claimUncertain || claimRecovery ? <Meta>Rescan or re-enter the exact same team code to confirm the earlier attempt.</Meta> : null}
      </Sheet>

      <Sheet
        onClose={() => {
          setShowTools(false)
          setFindText('')
        }}
        title="This hall"
        visible={showTools}
      >
        <Row
          detail={`Plan ${floor.plan.version} · ${floorMappingStateLabels[floor.plan.mappingState]}`}
          label={floor.plan.name}
        />
        <Row
          label={`${floor.zones.reduce((count, zone) => count + zone.teams.length, 0)} teams placed in your assigned zones`}
        />
        {floor.zones.length > 1
          ? floor.zones.map((zone) => (
              <Row detail={`${zone.teams.length} placed`} key={zone.id} label={zone.name} />
            ))
          : null}
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={setFindText}
          placeholder="Find a team"
          placeholderTextColor={palette.faint}
          style={styles.findInput}
          value={findText}
        />
        {placements.map((placement) => (
          <Row
            detail={`${floorAreaLabels[placement.area]}${
              floor.zones.length > 1 ? ` of ${placement.zoneName}` : ''
            } · ${placedAgo(placement.mappedAt)}`}
            key={placement.teamId}
            label={placement.teamName}
          />
        ))}
        {placements.length === 0 ? (
          <Nothing>
            {query ? 'Nobody has recorded that team yet.' : 'Nobody has been placed yet.'}
          </Nothing>
        ) : null}
      </Sheet>
    </View>
  )
}

function HallCanvas({
  areas,
  landmarks,
  onPick,
  picked,
  placing,
  recorded,
  teams,
}: {
  areas: readonly { area: FloorArea; teamCount: number }[]
  landmarks: readonly { id: string; name: string; x: number; y: number }[]
  onPick: (point: { x: number; y: number }) => void
  picked: { x: number; y: number } | null
  placing: boolean
  recorded: { x: number; y: number } | null
  teams: readonly { teamId: string; teamName: string; x: number; y: number }[]
}) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null)
  const [zoomedIn, setZoomedIn] = useState(false)

  const areaLoad = new Map(areas.map((entry) => [entry.area, entry.teamCount]))

  const stage = landmarks.find((landmark) => landmark.name === 'the stage') ?? null
  const stageDepth = stage ? Math.max(6, stage.y * 2) : 0

  const pointFrom = (locationX: number, locationY: number) => {
    if (!size || size.width === 0 || size.height === 0) return null
    return {
      x: clampPercent((locationX / size.width) * 100),
      y: clampPercent((locationY / size.height) * 100),
    }
  }

  return (
    <ScrollView
      centerContent
      contentContainerStyle={styles.canvasContent}
      maximumZoomScale={5}
      minimumZoomScale={1}
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout
        setFrame({ width, height })
      }}
      onScroll={(event) => setZoomedIn(event.nativeEvent.zoomScale >= teamNameZoom)}
      scrollEnabled={!placing}
      scrollEventThrottle={64}
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
    >
      {frame ? (
        <View
          onLayout={(event) => setSize(event.nativeEvent.layout)}
          style={[
            styles.room,
            {
              width: frame.width - canvasInset * 2,
              height: frame.height - canvasInset * 2,
            },
          ]}
          onMoveShouldSetResponder={() => placing}
          onResponderGrant={(event) => {
            const point = pointFrom(event.nativeEvent.locationX, event.nativeEvent.locationY)
            if (point) onPick(point)
          }}
          onResponderMove={(event) => {
            const point = pointFrom(event.nativeEvent.locationX, event.nativeEvent.locationY)
            if (point) onPick(point)
          }}
          onStartShouldSetResponder={() => placing}
        >
          {stage ? (
            <View pointerEvents="none" style={[styles.stage, { height: `${stageDepth}%` }]}>
              <Text style={styles.stageText}>STAGE</Text>
            </View>
          ) : null}

          <View pointerEvents="none" style={styles.grid}>
            {floorAreaRows.map((row, rowIndex) => (
              <View key={rowIndex} style={styles.gridRow}>
                {row.map((area) => {
                  const lit = picked !== null && floorAreaAt(picked.x, picked.y) === area
                  const count = areaLoad.get(area) ?? 0
                  return (
                    <View key={area} style={[styles.gridCell, lit ? styles.gridCellLit : null]}>
                      <Text style={[styles.gridCellText, lit ? styles.gridCellTextLit : null]}>
                        {floorAreaCellLabels[area]}
                      </Text>
                      {count > 0 ? (
                        <Text
                          style={[styles.gridCellCount, lit ? styles.gridCellTextLit : null]}
                        >
                          {count}
                        </Text>
                      ) : null}
                    </View>
                  )
                })}
              </View>
            ))}
          </View>

          {teams.map((team) => (
            <View
              key={team.teamId}
              pointerEvents="none"
              style={[
                styles.team,
                team.x > 70
                  ? [styles.teamFromRight, { right: `${100 - team.x}%`, top: `${team.y}%` }]
                  : [styles.teamFromLeft, { left: `${team.x}%`, top: `${team.y}%` }],
              ]}
            >
              <View style={styles.teamDot} />
              {zoomedIn ? (
                <Text numberOfLines={1} style={styles.teamName}>
                  {team.teamName}
                </Text>
              ) : null}
            </View>
          ))}

          {recorded ? (
            <View
              pointerEvents="none"
              style={[styles.recorded, { left: `${recorded.x}%`, top: `${recorded.y}%` }]}
            />
          ) : null}

          {picked ? (
            <View
              pointerEvents="none"
              style={[styles.pin, { left: `${picked.x}%`, top: `${picked.y}%` }]}
            />
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  )
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback)
}

function placedAgo(timestamp: number) {
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

const canvasInset = 12

const teamNameZoom = 1.5

const floorAreaRows = [
  ['north_west', 'north', 'north_east'],
  ['west', 'centre', 'east'],
  ['south_west', 'south', 'south_east'],
] as const satisfies readonly (readonly FloorArea[])[]

const floorAreaCellLabels: Record<FloorArea, string> = {
  north_west: 'NORTH\nWEST',
  north: 'NORTH',
  north_east: 'NORTH\nEAST',
  west: 'WEST',
  centre: 'MIDDLE',
  east: 'EAST',
  south_west: 'SOUTH\nWEST',
  south: 'SOUTH',
  south_east: 'SOUTH\nEAST',
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: palette.background },
  canvasFrame: { flex: 1 },
  canvasContent: { flexGrow: 1, justifyContent: 'center', padding: canvasInset },
  headline: { paddingHorizontal: 20, paddingTop: 4 },
  dock: { paddingHorizontal: 20, paddingTop: 6, paddingBottom: 34, gap: 12 },

  manualRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: {
    flex: 1,
    height: 50,
    paddingHorizontal: 14,
    color: palette.text,
    fontSize: 16,
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
  },
  findInput: {
    height: 50,
    paddingHorizontal: 14,
    color: palette.text,
    fontSize: 16,
    backgroundColor: palette.tile,
    borderRadius: radius.tile,
  },
  openButton: {
    height: 50,
    paddingHorizontal: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.hall,
    borderRadius: radius.control,
  },
  openButtonText: { color: palette.onHall, fontSize: 16, fontWeight: '600' },
  disabled: { backgroundColor: palette.tile },
  disabledText: { color: palette.faint },

  room: { backgroundColor: palette.tile, borderRadius: radius.tile, overflow: 'hidden' },
  stage: {
    position: 'absolute',
    top: 0,
    right: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.strong,
  },
  stageText: { color: palette.text, fontSize: 12, fontWeight: '700', letterSpacing: 3 },
  grid: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, flexDirection: 'column' },
  gridRow: { flex: 1, flexDirection: 'row' },
  gridCell: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.background,
  },
  gridCellLit: { backgroundColor: 'rgba(255,107,0,0.14)', borderColor: palette.hall },
  gridCellText: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.2,
    lineHeight: 16,
    textAlign: 'center',
  },
  gridCellCount: { color: palette.text, fontSize: 16, fontWeight: '700' },
  gridCellTextLit: { color: palette.hall },

  landmarkMid: { marginTop: -12 },
  landmarkHigh: { marginTop: -27 },

  team: { position: 'absolute', alignItems: 'center', gap: 4 },
  teamFromLeft: { flexDirection: 'row', transform: [{ translateX: -5 }, { translateY: -6 }] },
  teamFromRight: { flexDirection: 'row-reverse', transform: [{ translateX: 5 }, { translateY: -6 }] },
  teamDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: palette.faint },
  teamName: { maxWidth: 90, color: palette.text, fontSize: 8, fontWeight: '600' },

  recorded: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: palette.hall,
    transform: [{ translateX: -10 }, { translateY: -10 }],
  },
  pin: {
    position: 'absolute',
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 4,
    borderColor: palette.hall,
    backgroundColor: palette.background,
    transform: [{ translateX: -11 }, { translateY: -11 }],
  },
})
