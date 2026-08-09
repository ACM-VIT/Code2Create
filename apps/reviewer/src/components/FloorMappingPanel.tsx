import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { randomUUID } from 'expo-crypto'
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import {
  Action,
  Body,
  ChipRow,
  Meta,
  Problem,
  QuietAction,
  Section,
} from '@/components/ui'
import type { ReviewerRuntime } from '@/lib/runtime'
import { palette } from '@/theme'

type FloorState = NonNullable<FunctionReturnType<typeof api.floorMapping.available>>
type FloorZone = FloorState['zones'][number]
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
  const [claim, setClaim] = useState<FloorClaim | null>(null)
  const [receipt, setReceipt] = useState<FloorReceipt | null>(null)
  const [overrideReason, setOverrideReason] = useState('Corrected after confirming the team’s physical location')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (floor === undefined) return <Meta>Loading the hall plan…</Meta>
  if (!floor) return <Body>There is no hall plan yet, so there is nothing to map.</Body>

  const selectedZone = floor.zones.find((zone) => zone.id === selectedZoneId) ?? floor.zones[0]
  if (!selectedZone) return <Body>No zone of the hall has been assigned to you.</Body>

  const freeSpots = selectedZone.spots.filter((spot) => spot.occupiedBy === null).length

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

  const assignSpot = async (spotId: FloorZone['spots'][number]['id']) => {
    if (!claim || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await assignClaim({
        eventSlug,
        claimId: claim.id,
        spotId,
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
  }

  return (
    <>
      {/* Lead with how much of the hall is still unmapped, which is the whole
          reason anyone opens this screen. */}
      <Body>
        {freeSpots === 0
          ? `Every spot in ${selectedZone.name} is mapped.`
          : `${freeSpots} ${freeSpots === 1 ? 'spot is' : 'spots are'} still empty in ${selectedZone.name}.`}
      </Body>
      <Meta>
        {floor.mode === 'override'
          ? 'The map is frozen, so a change needs a reason.'
          : 'Scan the QR on the team’s own dashboard, then tap where they are sitting.'}
      </Meta>

      {!claim && !receipt ? (
        <>
          {floor.zones.length > 1 ? (
            <ChipRow
              accent={palette.hall}
              onSelect={setSelectedZoneId}
              options={floor.zones.map((zone) => [zone.id, zone.name] as const)}
              selected={selectedZone.id}
            />
          ) : null}
          {!permission ? <Meta>Checking camera access…</Meta> : null}
          {permission && !permission.granted ? (
            <Action
              accent={palette.hall}
              label="Allow the camera"
              onPress={async () => { await requestPermission() }}
            />
          ) : null}
          {permission?.granted ? (
            <View style={styles.cameraFrame}>
              <CameraView
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                facing="back"
                onBarcodeScanned={busy ? undefined : handleBarcode}
                style={StyleSheet.absoluteFill}
              />
              <View pointerEvents="none" style={styles.cameraGuide} />
            </View>
          ) : null}
          {/* The typed code is the fallback for a QR that will not read, so it
              sits under the camera rather than competing with it. */}
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
              style={[styles.openButton, busy || manualCode.trim().length < 10 ? styles.disabled : null]}
            >
              <Text style={styles.openButtonText}>{busy ? '…' : 'Open'}</Text>
            </Pressable>
          </View>
        </>
      ) : null}

      {claim ? (
        <Section title={claim.team.name}>
          <Meta>
            {claim.currentLocation
              ? `Currently at ${claim.currentLocation.zoneName}, ${claim.currentLocation.spotLabel}.`
              : 'Nowhere on the map yet.'}
          </Meta>
          {claim.mode === 'override' ? (
            <TextInput
              multiline
              onChangeText={setOverrideReason}
              placeholder="Why is this frozen location changing?"
              placeholderTextColor={palette.faint}
              style={[styles.input, styles.reasonInput]}
              value={overrideReason}
            />
          ) : null}
          <Meta>Tap where they are sitting in {selectedZone.name}</Meta>
          <FloorCanvas
            claim={claim}
            disabled={busy || (claim.mode === 'override' && overrideReason.trim().length < 5)}
            onSelect={assignSpot}
            zone={selectedZone}
          />
          <QuietAction disabled={busy} label="Scan a different team" onPress={reset} />
        </Section>
      ) : null}

      {receipt ? (
        <Section title="Saved">
          <Body>
            {receipt.teamName} is at {receipt.zoneName}, {receipt.spotLabel}.
          </Body>
          <Action accent={palette.hall} label="Scan the next team" onPress={reset} />
        </Section>
      ) : null}

      {error ? <Problem>{error}</Problem> : null}
    </>
  )
}

function FloorCanvas({
  claim,
  disabled,
  onSelect,
  zone,
}: {
  claim: FloorClaim
  disabled: boolean
  onSelect: (spotId: FloorZone['spots'][number]['id']) => void | Promise<void>
  zone: FloorZone
}) {
  return (
    <View style={styles.map}>
      {zone.spots.map((spot) => {
        const occupiedByAnotherTeam = spot.occupiedBy && spot.occupiedBy.teamId !== claim.team.id
        return (
          <Pressable
            accessibilityLabel={`${spot.label}${spot.occupiedBy ? `, occupied by ${spot.occupiedBy.teamName}` : ', available'}`}
            accessibilityRole="button"
            disabled={disabled || Boolean(occupiedByAnotherTeam)}
            key={spot.id}
            onPress={() => void onSelect(spot.id)}
            style={[
              styles.mapSpot,
              { left: `${spot.x}%`, top: `${spot.y}%` },
              spot.occupiedBy ? styles.mapSpotOccupied : null,
              occupiedByAnotherTeam ? styles.mapSpotDisabled : null,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[styles.mapSpotText, spot.occupiedBy ? styles.mapSpotTextOccupied : null]}
            >
              {spot.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function errorMessage(value: unknown, fallback: string) {
  if (value instanceof Error && value.message.trim()) return value.message
  return fallback
}

const styles = StyleSheet.create({
  /* The viewfinder is the screen's subject, so it gets real height and the
     guide is the only thing drawn over it. */
  cameraFrame: { height: 280, overflow: 'hidden', backgroundColor: '#000' },
  cameraGuide: {
    position: 'absolute',
    top: 48,
    right: 48,
    bottom: 48,
    left: 48,
    borderWidth: 2,
    borderColor: palette.hall,
  },

  manualRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: {
    flex: 1,
    height: 50,
    paddingHorizontal: 14,
    color: palette.text,
    fontSize: 16,
    backgroundColor: palette.tile,
  },
  reasonInput: { height: 90, paddingTop: 13, textAlignVertical: 'top' },
  openButton: {
    height: 50,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.hall,
  },
  openButtonText: { color: palette.onHall, fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.4 },

  /* Spots are tap targets before they are a diagram: big enough to hit while
     standing, and colour-coded so a full zone reads at a glance. */
  map: { position: 'relative', width: '100%', aspectRatio: 1.45, backgroundColor: palette.tile },
  mapSpot: {
    position: 'absolute',
    minWidth: 44,
    maxWidth: 78,
    paddingHorizontal: 6,
    paddingVertical: 8,
    backgroundColor: palette.hall,
    transform: [{ translateX: -22 }, { translateY: -16 }],
  },
  mapSpotOccupied: { backgroundColor: palette.strong },
  mapSpotDisabled: { opacity: 0.35 },
  mapSpotText: { color: palette.onHall, fontSize: 11, fontWeight: '700', textAlign: 'center' },
  mapSpotTextOccupied: { color: palette.text },
})
