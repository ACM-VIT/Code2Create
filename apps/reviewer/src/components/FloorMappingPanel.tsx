import { api } from '@code2create/backend/api'
import { floorAreaAt, floorAreaLabels } from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { randomUUID } from 'expo-crypto'
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { useRef, useState } from 'react'
import { Stack } from 'expo-router'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import {
  Action,
  Body,
  ChipRow,
  Field,
  HeaderButton,
  Lead,
  Meta,
  Problem,
  QuietAction,
  Sheet,
  Shell,
  Viewfinder,
} from '@/components/ui'
import { describeError } from '@/lib/errors'
import type { ReviewerRuntime } from '@/lib/runtime'
import { palette, radius } from '@/theme'

type FloorClaim = FunctionReturnType<typeof api.floorMapping.claimTeamQr>
type FloorReceipt = FunctionReturnType<typeof api.floorMapping.assignClaim>

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
  const [claim, setClaim] = useState<FloorClaim | null>(null)
  const [receipt, setReceipt] = useState<FloorReceipt | null>(null)
  const [overrideReason, setOverrideReason] = useState('Corrected after confirming the team’s physical location')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (floor === undefined) return <Shell />
  if (!floor) return <Body>There is no hall plan yet, so there is nothing to map.</Body>

  const selectedZone = floor.zones.find((zone) => zone.id === selectedZoneId) ?? floor.zones[0]
  if (!selectedZone) return <Body>No zone of the hall has been assigned to you.</Body>


  const claimCredential = async (credential: string) => {
    if (busyRef.current || claim || receipt) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await claimTeamQr({
        eventSlug,
        destinationZoneId: selectedZone.id,
        credential,
        clientOperationId: randomUUID(),
      })
      setClaim(result)
      setManualCode('')
    } catch (caught) {
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
      const result = await assignClaim({
        eventSlug,
        claimId: claim.id,
        x: point.x,
        y: point.y,
        expectedClaimVersion: claim.version,
        ...(claim.mode === 'override' ? { reason: overrideReason } : {}),
        clientOperationId: randomUUID(),
      })
      setReceipt(result)
      setClaim(null)
    } catch (caught) {
      setError(errorMessage(caught, 'That location could not be saved.'))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const reset = () => {
    setClaim(null)
    setReceipt(null)
    setError(null)
    setManualCode('')
    setPicked(null)
  }

  const placing = claim
  const areaName = picked ? floorAreaLabels[floorAreaAt(picked.x, picked.y)] : null

  const placeHere = async () => {
    if (!picked) return
    await assignAt(picked)
    setPicked(null)
  }

  return (
    <View style={styles.frame}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton label="Scan a team" onPress={() => setShowScanner(true)} />
          ),
        }}
      />

      <View style={styles.canvasFrame}>
        <HallCanvas
          depthMeters={selectedZone.depthMeters}
          landmarks={selectedZone.landmarks}
          onPick={(point) => {
            setError(null)
            setPicked(point)
          }}
          picked={picked}
          teams={selectedZone.teams}
          widthMeters={selectedZone.widthMeters}
        />
      </View>

      <View style={styles.dock}>
        <Lead
          accent={palette.hall}
          detail={
            placing
              ? `Touch where ${placing.team.name} is sitting.`
              : 'Scan a team, then touch where they are.'
          }
          unit={selectedZone.teams.length === 1 ? 'team placed' : 'teams placed'}
          value={String(selectedZone.teams.length)}
        />

        {floor.zones.length > 1 ? (
          <ChipRow
            accent={palette.hall}
            onSelect={(zoneId) => {
              setSelectedZoneId(zoneId)
              setPicked(null)
            }}
            options={floor.zones.map((zone) => [zone.id, zone.name] as const)}
            selected={selectedZone.id}
          />
        ) : null}

        {areaName ? <Meta>{areaName} of {selectedZone.name}</Meta> : null}
        {error ? <Problem>{error}</Problem> : null}

        {placing ? (
          <>
            {placing.mode === 'override' ? (
              <Field
                label="Why is this frozen location changing?"
                multiline
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
                picked
                  ? `Put ${placing.team.name} here`
                  : `Touch the room for ${placing.team.name}`
              }
              onPress={placeHere}
            />
            <QuietAction disabled={busy} label="Scan a different team" onPress={reset} />
          </>
        ) : receipt ? (
          <>
            <Meta>
              {receipt.teamName} is in the {receipt.description}.
            </Meta>
            <Action accent={palette.hall} label="Place the next team" onPress={reset} />
          </>
        ) : (
          <Action
            accent={palette.hall}
            label="Scan a team to place"
            onPress={() => setShowScanner(true)}
          />
        )}
      </View>

      <Sheet onClose={() => setShowScanner(false)} title="Scan a team" visible={showScanner}>
        <Body>The QR is on the team’s own dashboard. There are no table stickers.</Body>
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
          <Viewfinder accent={palette.hall}>
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
            placeholder="Type the team's code instead"
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
            <Text style={styles.openButtonText}>{busy ? '…' : 'Open'}</Text>
          </Pressable>
        </View>
      </Sheet>
    </View>
  )
}

/**
 * The room itself, drawn at the proportions of the real hall and touched
 * wherever a team is actually sitting.
 *
 * There are no numbered tables here and there never were: they get dragged
 * around all weekend and nobody can identify one. What a mapper standing in
 * the room can honestly record is roughly where somebody is, so that is what
 * this takes — a point, which the server turns into a part of the room and the
 * nearest landmark, which is what an operator says out loud to a reviewer
 * walking over.
 */
function HallCanvas({
  landmarks,
  onPick,
  picked,
  teams,
  widthMeters,
  depthMeters,
}: {
  landmarks: readonly { id: string; name: string; x: number; y: number }[]
  onPick: (point: { x: number; y: number }) => void
  picked: { x: number; y: number } | null
  teams: readonly { teamId: string; teamName: string; x: number; y: number }[]
  widthMeters: number
  depthMeters: number
}) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  return (
    <View
      onLayout={(event) => setSize(event.nativeEvent.layout)}
      style={[styles.room, { aspectRatio: widthMeters / depthMeters }]}
    >
      <Pressable
        accessibilityHint="Touch where the team is sitting"
        accessibilityLabel="Hall"
        accessibilityRole="button"
        onPress={(event) => {
          if (!size || size.width === 0 || size.height === 0) return
          onPick({
            x: clampPercent((event.nativeEvent.locationX / size.width) * 100),
            y: clampPercent((event.nativeEvent.locationY / size.height) * 100),
          })
        }}
        style={StyleSheet.absoluteFill}
      >
        {/* Thirds, drawn faintly. They are how the room is named, so seeing
            them is what makes "north-east" mean something to the mapper. */}
        <View pointerEvents="none" style={[styles.gridLine, styles.gridV, { left: '33.333%' }]} />
        <View pointerEvents="none" style={[styles.gridLine, styles.gridV, { left: '66.666%' }]} />
        <View pointerEvents="none" style={[styles.gridLine, styles.gridH, { top: '33.333%' }]} />
        <View pointerEvents="none" style={[styles.gridLine, styles.gridH, { top: '66.666%' }]} />
      </Pressable>

      {landmarks.map((landmark) => (
        <View
          key={landmark.id}
          pointerEvents="none"
          style={[styles.landmark, { left: `${landmark.x}%`, top: `${landmark.y}%` }]}
        >
          <Text numberOfLines={1} style={styles.landmarkText}>
            {landmark.name}
          </Text>
        </View>
      ))}

      {teams.map((team) => (
        <View
          key={team.teamId}
          pointerEvents="none"
          style={[styles.team, { left: `${team.x}%`, top: `${team.y}%` }]}
        />
      ))}

      {picked ? (
        <View
          pointerEvents="none"
          style={[styles.pin, { left: `${picked.x}%`, top: `${picked.y}%` }]}
        />
      ) : null}
    </View>
  )
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback)
}

const styles = StyleSheet.create({
  frame: { flex: 1, backgroundColor: palette.background },
  /* The room takes whatever the dock does not. */
  canvasFrame: { flex: 1, padding: 12 },
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
  openButton: {
    height: 50,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.hall,
  },
  openButtonText: { color: palette.onHall, fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.4 },

  /* The room at the proportions of the real hall, so what a mapper sees on
     the phone matches what they are standing in. */
  room: { width: '100%', backgroundColor: palette.tile, borderRadius: radius.tile, overflow: 'hidden' },
  gridLine: { position: 'absolute', backgroundColor: palette.background, opacity: 0.5 },
  gridV: { top: 0, bottom: 0, width: 1 },
  gridH: { left: 0, right: 0, height: 1 },

  landmark: {
    position: 'absolute',
    paddingHorizontal: 7,
    paddingVertical: 4,
    backgroundColor: palette.background,
    transform: [{ translateX: -34 }, { translateY: -12 }],
  },
  landmarkText: { color: palette.muted, fontSize: 11, fontWeight: '600' },

  /* Teams already placed, so a crowded corner is visible before you add to it. */
  team: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: palette.strong,
    transform: [{ translateX: -5 }, { translateY: -5 }],
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
