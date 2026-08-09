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
  Card,
  ChipRow,
  Field,
  Heading,
  Lead,
  Meta,
  Problem,
  QuietAction,
  Section,
  Shell,
  Viewfinder,
} from '@/components/ui'
import { describeError } from '@/lib/errors'
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
  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(null)
  const [claim, setClaim] = useState<FloorClaim | null>(null)
  const [receipt, setReceipt] = useState<FloorReceipt | null>(null)
  const [overrideReason, setOverrideReason] = useState('Corrected after confirming the team’s physical location')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (floor === undefined) return <Shell />
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

  const placing = claim
  const selectedSpot = selectedSpotId
    ? selectedZone.spots.find((spot) => spot.id === selectedSpotId)
    : undefined

  const tapSpot = (spot: FloorZone['spots'][number]) => {
    setError(null)
    setSelectedSpotId(spot.id)
    // With a team in hand a tap is a placement. Without one it answers "who is
    // sitting there", which is the other question people bring to this screen.
    if (placing && spot.occupiedBy && spot.occupiedBy.teamId !== placing.team.id) {
      setError(`${spot.label} is ${spot.occupiedBy.teamName}. Move them first.`)
    }
  }

  const placeHere = async () => {
    if (!selectedSpot) return
    await assignSpot(selectedSpot.id)
    setSelectedSpotId(null)
  }

  return (
    <>
      <Lead
        accent={palette.hall}
        detail={
          floor.mode === 'override'
            ? 'The map is frozen, so a change needs a reason.'
            : placing
              ? `Tap where ${placing.team.name} is sitting.`
              : 'Tap a spot to see who is there, or scan a team to place them.'
        }
        unit={freeSpots === 1 ? 'spot still empty' : 'spots still empty'}
        value={String(freeSpots)}
      />

      {floor.zones.length > 1 ? (
        <ChipRow
          accent={palette.hall}
          onSelect={(zoneId) => {
            setSelectedZoneId(zoneId)
            setSelectedSpotId(null)
          }}
          options={floor.zones.map((zone) => [zone.id, zone.name] as const)}
          selected={selectedZone.id}
        />
      ) : null}

      <HallCanvas
        disabled={busy}
        onSelect={tapSpot}
        placingTeamId={placing ? placing.team.id : null}
        selectedSpotId={selectedSpotId}
        zone={selectedZone}
      />

      {selectedSpot ? (
        <Card accent={palette.hall} selected>
          <Heading>{selectedSpot.label}</Heading>
          <Meta>
            {selectedSpot.occupiedBy ? selectedSpot.occupiedBy.teamName : 'Nobody here yet'}
          </Meta>
        </Card>
      ) : null}

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
              !selectedSpot ||
              Boolean(
                selectedSpot.occupiedBy && selectedSpot.occupiedBy.teamId !== placing.team.id,
              ) ||
              (placing.mode === 'override' && overrideReason.trim().length < 5)
            }
            label={
              selectedSpot
                ? `Put ${placing.team.name} at ${selectedSpot.label}`
                : `Tap a spot for ${placing.team.name}`
            }
            onPress={placeHere}
          />
          <QuietAction disabled={busy} label="Scan a different team" onPress={reset} />
        </>
      ) : receipt ? (
        <>
          <Card accent={palette.hall} selected>
            <Heading>{receipt.teamName}</Heading>
            <Meta>
              {receipt.zoneName} · {receipt.spotLabel}
            </Meta>
          </Card>
          <Action accent={palette.hall} label="Scan the next team" onPress={reset} />
        </>
      ) : (
        <Section title="Scan a team">
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
        </Section>
      )}
    </>
  )
}

/**
 * The hall itself, as a thing you point at.
 *
 * Mapping is a spatial job: someone is standing in the room looking at where a
 * team is sitting. Asking them to read a list of spot labels and pick the right
 * string is a translation step that only exists because it was easier to build.
 * This draws the zone to scale from the published plan and lets them touch the
 * place.
 */
function HallCanvas({
  disabled,
  onSelect,
  placingTeamId,
  selectedSpotId,
  zone,
}: {
  disabled: boolean
  onSelect: (spot: FloorZone['spots'][number]) => void
  /** The team being placed, so its current spot reads as "theirs", not "taken". */
  placingTeamId: string | null
  selectedSpotId: string | null
  zone: FloorZone
}) {
  return (
    <View style={styles.map}>
      {zone.spots.map((spot) => {
        const theirs = spot.occupiedBy !== null && spot.occupiedBy.teamId === placingTeamId
        const takenByAnother = spot.occupiedBy !== null && !theirs
        const selected = spot.id === selectedSpotId
        return (
          <Pressable
            accessibilityLabel={
              spot.occupiedBy ? `${spot.label}, ${spot.occupiedBy.teamName}` : `${spot.label}, free`
            }
            accessibilityRole="button"
            accessibilityState={{ disabled, selected }}
            disabled={disabled}
            key={spot.id}
            onPress={() => onSelect(spot)}
            style={({ pressed }) => [
              styles.spot,
              { left: `${spot.x}%`, top: `${spot.y}%` },
              takenByAnother ? styles.spotTaken : null,
              theirs ? styles.spotTheirs : null,
              selected ? styles.spotSelected : null,
              pressed ? styles.spotPressed : null,
            ]}
          >
            <Text
              numberOfLines={1}
              style={[
                styles.spotText,
                takenByAnother ? styles.spotTextTaken : null,
                theirs || selected ? styles.spotTextOn : null,
              ]}
            >
              {spot.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback)
}

const styles = StyleSheet.create({
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: {
    flex: 1,
    height: 50,
    paddingHorizontal: 14,
    color: palette.text,
    fontSize: 16,
    backgroundColor: palette.tile,
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

  /* The zone drawn to the plan's own proportions, tall enough that a spot is a
     thumb target rather than a dot on a diagram. */
  map: {
    position: 'relative',
    width: '100%',
    aspectRatio: 1.15,
    backgroundColor: palette.tile,
  },
  spot: {
    position: 'absolute',
    minWidth: 52,
    maxWidth: 86,
    paddingHorizontal: 6,
    paddingVertical: 10,
    backgroundColor: palette.strong,
    transform: [{ translateX: -26 }, { translateY: -18 }],
  },
  spotTaken: { backgroundColor: palette.background },
  spotTheirs: { backgroundColor: palette.hall },
  spotSelected: { backgroundColor: palette.hall },
  spotPressed: { opacity: 0.7 },
  spotText: { color: palette.text, fontSize: 12, fontWeight: '600', textAlign: 'center' },
  spotTextTaken: { color: palette.muted },
  spotTextOn: { color: palette.onHall },
})
