import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { randomUUID } from 'expo-crypto'
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera'
import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'

import type { ReviewerRuntime } from '@/lib/runtime'

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

  if (floor === undefined) {
    return <Panel><Text style={styles.body}>Loading hall map…</Text></Panel>
  }
  if (!floor) {
    return (
      <Panel>
        <Text style={styles.title}>Hall mapping</Text>
        <Text style={styles.body}>No current floor plan or exact mapping permission is available to this account.</Text>
      </Panel>
    )
  }

  const selectedZone = floor.zones.find((zone) => zone.id === selectedZoneId) ?? floor.zones[0]
  if (!selectedZone) {
    return <Panel><Text style={styles.body}>No mapped zone is assigned to this account.</Text></Panel>
  }

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
    <Panel>
      <View style={styles.headingRow}>
        <View style={styles.grow}>
          <Text style={styles.eyebrow}>Hall mapping</Text>
          <Text style={styles.title}>{floor.plan.name}</Text>
        </View>
        <Text style={floor.mode === 'override' ? styles.overrideState : styles.liveState}>
          {floor.mode === 'override' ? 'Frozen' : 'Open'}
        </Text>
      </View>
      <Text style={styles.body}>
        Scan the QR on the team’s dashboard, then tap the spot where they are sitting. There are no table QR stickers.
      </Text>

      {!claim && !receipt ? (
        <>
          <View style={styles.zoneRow}>
            {floor.zones.map((zone) => (
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                key={zone.id}
                onPress={() => setSelectedZoneId(zone.id)}
                style={[styles.zoneButton, zone.id === selectedZone.id ? styles.zoneButtonSelected : null]}
              >
                <Text style={zone.id === selectedZone.id ? styles.zoneTextSelected : styles.zoneText}>{zone.name}</Text>
              </Pressable>
            ))}
          </View>
          {!permission ? <Text style={styles.body}>Checking camera access…</Text> : null}
          {permission && !permission.granted ? (
            <Button label="Allow camera" onPress={async () => { await requestPermission() }} />
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
          <View style={styles.manualRow}>
            <TextInput
              autoCapitalize="characters"
              editable={!busy}
              onChangeText={setManualCode}
              placeholder="Fallback code"
              placeholderTextColor="#716d66"
              style={styles.input}
              value={manualCode}
            />
            <Button
              compact
              disabled={busy || manualCode.trim().length < 10}
              label={busy ? 'Checking…' : 'Open'}
              onPress={() => claimCredential(manualCode)}
            />
          </View>
        </>
      ) : null}

      {claim ? (
        <View style={styles.claimCard}>
          <Text style={styles.eyebrow}>Scanned team</Text>
          <Text style={styles.teamName}>{claim.team.name}</Text>
          <Text style={styles.body}>
            {claim.currentLocation
              ? `Currently ${claim.currentLocation.zoneName} · ${claim.currentLocation.spotLabel}.`
              : 'No hall location is recorded yet.'}
          </Text>
          {claim.mode === 'override' ? (
            <TextInput
              multiline
              onChangeText={setOverrideReason}
              placeholder="Why is this frozen location changing?"
              placeholderTextColor="#716d66"
              style={[styles.input, styles.reasonInput]}
              value={overrideReason}
            />
          ) : null}
          <Text style={styles.label}>Tap their exact spot in {selectedZone.name}</Text>
          <FloorCanvas
            claim={claim}
            disabled={busy || (claim.mode === 'override' && overrideReason.trim().length < 5)}
            onSelect={assignSpot}
            zone={selectedZone}
          />
          <Button label="Scan again" secondary disabled={busy} onPress={reset} />
        </View>
      ) : null}

      {receipt ? (
        <View style={styles.receipt}>
          <Text style={styles.saved}>Saved</Text>
          <Text style={styles.teamName}>{receipt.teamName}</Text>
          <Text style={styles.body}>{receipt.zoneName} · {receipt.spotLabel}</Text>
          <Button label="Scan next team" onPress={reset} />
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </Panel>
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
            <Text numberOfLines={1} style={styles.mapSpotText}>{spot.label}</Text>
          </Pressable>
        )
      })}
    </View>
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
  compact = false,
}: {
  label: string
  onPress: () => void | Promise<void>
  disabled?: boolean
  secondary?: boolean
  compact?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        secondary ? styles.secondaryButton : null,
        compact ? styles.compactButton : null,
        disabled ? styles.disabled : null,
      ]}
    >
      <Text style={[styles.buttonText, secondary ? styles.secondaryButtonText : null]}>{label}</Text>
    </Pressable>
  )
}

function errorMessage(value: unknown, fallback: string) {
  if (value instanceof Error && value.message.trim()) return value.message
  return fallback
}

const styles = StyleSheet.create({
  panel: { gap: 16, paddingVertical: 22, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#34322e' },
  headingRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 },
  grow: { flex: 1 },
  eyebrow: { color: '#a6a19a', fontSize: 12, marginBottom: 5 },
  title: { color: '#f1eee8', fontFamily: 'Georgia', fontSize: 25, lineHeight: 31 },
  body: { color: '#aaa69f', fontSize: 14, lineHeight: 21 },
  label: { color: '#aaa69f', fontSize: 12 },
  liveState: { color: '#b8c8ad', fontSize: 12 },
  overrideState: { color: '#d6a0aa', fontSize: 12 },
  zoneRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  zoneButton: { paddingHorizontal: 12, paddingVertical: 9, borderWidth: 1, borderColor: '#34322e', borderRadius: 6 },
  zoneButtonSelected: { backgroundColor: '#eee9e0', borderColor: '#eee9e0' },
  zoneText: { color: '#aaa69f', fontSize: 13 },
  zoneTextSelected: { color: '#11110f', fontSize: 13 },
  cameraFrame: { height: 250, overflow: 'hidden', backgroundColor: '#11110f', borderRadius: 8 },
  cameraGuide: { position: 'absolute', top: 45, right: 45, bottom: 45, left: 45, borderWidth: 1, borderColor: '#eee9e0', borderRadius: 8 },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  input: { flex: 1, minHeight: 46, paddingHorizontal: 12, color: '#f1eee8', backgroundColor: '#11110f', borderWidth: 1, borderColor: '#34322e', borderRadius: 6 },
  reasonInput: { minHeight: 76, paddingTop: 11, textAlignVertical: 'top' },
  claimCard: { gap: 14 },
  teamName: { color: '#f1eee8', fontSize: 20, fontWeight: '600' },
  map: { position: 'relative', width: '100%', aspectRatio: 1.45, backgroundColor: '#11110f', borderWidth: 1, borderColor: '#34322e', borderRadius: 8 },
  mapSpot: { position: 'absolute', minWidth: 38, maxWidth: 74, paddingHorizontal: 5, paddingVertical: 5, backgroundColor: '#eee9e0', borderRadius: 4, transform: [{ translateX: -19 }, { translateY: -13 }] },
  mapSpotOccupied: { backgroundColor: '#d6a0aa' },
  mapSpotDisabled: { opacity: 0.38 },
  mapSpotText: { color: '#11110f', fontSize: 10, fontWeight: '700', textAlign: 'center' },
  receipt: { gap: 12, padding: 16, backgroundColor: '#11110f', borderWidth: 1, borderColor: '#34322e', borderRadius: 8 },
  saved: { color: '#b8c8ad', fontSize: 14, fontWeight: '700' },
  button: { minHeight: 48, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, backgroundColor: '#eee9e0', borderRadius: 7 },
  compactButton: { minHeight: 46 },
  buttonText: { color: '#11110f', fontSize: 14, fontWeight: '600' },
  secondaryButton: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#46433e' },
  secondaryButtonText: { color: '#ddd9d1' },
  disabled: { opacity: 0.45 },
  error: { color: '#e3a4a4', fontSize: 13, lineHeight: 19 },
})
