import { api } from '@code2create/backend/api'
import {
  floorAreaAt,
  floorAreaLabels,
  floorMappingStateLabels,
  type FloorArea,
} from '@code2create/domain'
import type { FunctionReturnType } from 'convex/server'
import { useMutation, useQuery } from 'convex/react'
import { randomUUID } from 'expo-crypto'
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
  const [showTools, setShowTools] = useState(false)
  const [findText, setFindText] = useState('')
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

  /* The scanned team's location as the server currently has it, drawn on the
     room whenever it falls in the zone being looked at, so moving a team is a
     correction made against the old spot rather than blind. */
  const recorded =
    placing?.currentLocation && placing.currentLocation.zoneId === selectedZone.id
      ? { x: placing.currentLocation.x, y: placing.currentLocation.y }
      : null

  /* Everything a mapper can already see, flattened for finding one team in
     it. Sorted newest first because the team being asked about is usually the
     one somebody just walked past. */
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

  return (
    <View style={styles.frame}>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton label="Hall tools" onPress={() => setShowTools(true)} />
          ),
        }}
      />

      {/* The second line is the number that decides whether to keep walking:
          teams that could be placed but have no recorded spot yet, across the
          whole hall rather than just this zone. Frozen takes the line when it
          applies, because it changes what a scan means, and being told the
          plan is frozen matters more than being told it is nearly done. */}
      <View style={styles.headline}>
        <Lead
          accent={palette.hall}
          {...(floor.plan.mappingState === 'frozen'
            ? { detail: floorMappingStateLabels.frozen }
            : floor.hall.unplacedTeamCount > 0
              ? { detail: `${floor.hall.unplacedTeamCount} still to place` }
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
            {placing.currentLocation ? (
              <Meta>Currently in the {placing.currentLocation.description}.</Meta>
            ) : null}
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
              {receipt.teamName} is {receipt.unchanged ? 'still ' : ''}in the {receipt.description}.
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

      <Sheet
        detents={[0.9]}
        onClose={() => setShowScanner(false)}
        title="Scan a team"
        visible={showScanner}
      >
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

      {/* Everything about the hall that is not placing a team: which plan is
          live, whether locations are frozen, how much of the hall is still
          unplaced, and where any already-placed team is. The header button
          used to open the scanner, which the button under the map already
          does; a menu that repeats the screen is not a menu. */}
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
          label={
            floor.hall.unplacedTeamCount > 0
              ? `${floor.hall.unplacedTeamCount} ${
                  floor.hall.unplacedTeamCount === 1 ? 'team' : 'teams'
                } still to place`
              : 'Every team has a recorded spot'
          }
        />
        {/* One count per zone, whole plan, so a mapper covering several zones
            can see which end of the hall is still thin before walking there.
            With a single zone the count is already the headline. */}
        {floor.hall.zones.length > 1
          ? floor.hall.zones.map((zone) => (
              <Row detail={`${zone.teamCount} placed`} key={zone.id} label={zone.name} />
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

/**
 * The room itself, touched wherever a team is actually sitting.
 *
 * There are no numbered tables here and there never were: they get dragged
 * around all weekend and nobody can identify one. What a mapper standing in
 * the room can honestly record is roughly where somebody is, so that is what
 * this takes — a point, which the server turns into a part of the room and the
 * nearest landmark, which is what an operator says out loud to a reviewer
 * walking over.
 *
 * Drawn portrait, filling the frame, with the stage still at the top — which
 * means the drawing gives up the room's metric proportions. The hall is wider
 * than it is deep (the stage spans the long wall), so its honest shape is a
 * squat strip that wastes most of a phone held upright, and the only way to
 * fill the screen at true proportions would be to rotate the plan onto its
 * side. But the nine area names are compass words defined on a plan with hall
 * north — the stage end — at the top, and every other surface of this system
 * says them that way: rotate the drawing and the cell labelled NORTH-EAST
 * lands at the bottom-right of the screen while the operator still says
 * "north-east corner". Orientation is the thing that has to stay true,
 * because it is shared. What a finger judges when it places a pin is
 * proportion — halfway across, two thirds of the way back — and proportion
 * survives scaling each axis independently. Only diagonal distance lies, and
 * nobody measures metres on a phone in a hall.
 */
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
  /** While placing, a touch draws on the room. Otherwise it pans and zooms it. */
  placing: boolean
  /** Where the server last put the team being placed, if it is in this zone. */
  recorded: { x: number; y: number } | null
  teams: readonly { teamId: string; teamName: string; x: number; y: number }[]
}) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  /* A percentage size inside a zoomable scroll view resolves against content
     that has no bound yet, so the room has to be told the frame it fills. */
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null)
  /* Team names exist only past this zoom: a hundred names over a whole room
     is noise, but once someone has zoomed into a corner, which teams are
     already in it is the thing they came to see. */
  const [zoomedIn, setZoomedIn] = useState(false)

  const areaLoad = new Map(areas.map((entry) => [entry.area, entry.teamCount]))

  /* The plan names its fixtures; the stage is the one worth drawing rather
     than pinning, because it spans the end of the room instead of sitting at
     a point in it. */
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
      /* Placing takes the touches, so a drag adjusts the pin instead of
         scrolling the room out from under the finger. */
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
          /* Touch anywhere and drag: the pin follows the finger, so the last
             thing you see before lifting is where it will be recorded. A tap is
             just a drag that did not move. */
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
          {/* The stage, drawn where the plan puts it. It is the one thing in the
              room that never moves, so a mapper holding the phone up can tell at
              a glance which way round they are standing. */}
          {stage ? (
            <View pointerEvents="none" style={[styles.stage, { height: `${stageDepth}%` }]}>
              <Text style={styles.stageText}>STAGE</Text>
            </View>
          ) : null}

          {/* The nine named areas, drawn as the grid they are, each labelled
              with the words an operator says out loud and the server's own
              count of teams already in it — so a crowded corner is a number
              before it is a walk. Seeing the vocabulary on the map is what
              makes "north-east corner" mean something to both the mapper
              touching it and the reviewer being sent there. */}
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

          {/* Each fixture is a dot at its true point with its name beside it,
              growing toward the middle of the room, so a name against a wall
              hugs the wall it names instead of being clipped by it. */}
          {landmarks.filter((landmark) => landmark !== stage).map((landmark) => (
            <View
              key={landmark.id}
              pointerEvents="none"
              style={[
                styles.landmark,
                landmark.x <= 50
                  ? [styles.landmarkFromLeft, { left: `${landmark.x}%` }]
                  : [styles.landmarkFromRight, { right: `${100 - landmark.x}%` }],
                { top: `${landmark.y}%` },
                landmark.y > 88 ? styles.landmarkHigh : styles.landmarkMid,
              ]}
            >
              <View style={styles.landmarkDot} />
              <Text numberOfLines={1} style={styles.landmarkText}>
                {landmark.name}
              </Text>
            </View>
          ))}

          {/* Teams already placed, so a crowded corner is visible before you
              add to it. The name is set at a size meant for the zoomed-in map:
              the scroll view scales text with everything else, so a label that
              would be clutter over the whole room is exactly readable at the
              zoom where a busy corner separates into teams. */}
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

/** Coarse on purpose: the answer feeds "they were placed a while ago". */
function placedAgo(timestamp: number) {
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

const canvasInset = 12

/** Past this zoom a corner has spread out enough for names to fit between dots. */
const teamNameZoom = 1.5

/** The nine named areas, laid out the way they sit in the room. */
const floorAreaRows = [
  ['north_west', 'north', 'north_east'],
  ['west', 'centre', 'east'],
  ['south_west', 'south', 'south_east'],
] as const satisfies readonly (readonly FloorArea[])[]

/**
 * The spoken labels with "corner" and "side" dropped, broken for a cell a
 * third of a phone wide. NW/N/NE fit anywhere but read as a crossword; these
 * are the words that actually get said over the noise.
 */
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
  /* The room takes whatever the dock does not, and sits in the middle of it
     rather than against the top with a void underneath. */
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
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.hall,
  },
  openButtonText: { color: palette.onHall, fontSize: 16, fontWeight: '600' },
  disabled: { opacity: 0.4 },

  /* The room fills its frame instead of keeping the hall's metric shape; the
     reasoning is on HallCanvas. */
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
  /* The area the pin is in, so the words under the map and the cell under the
     finger are visibly the same place. */
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

  landmark: { position: 'absolute', maxWidth: '60%', alignItems: 'center', gap: 5 },
  landmarkFromLeft: { flexDirection: 'row', transform: [{ translateX: -3 }] },
  landmarkFromRight: { flexDirection: 'row-reverse', transform: [{ translateX: 3 }] },
  /* Vertically centred on its point, except against the bottom edge, where
     the name would leave the room. */
  landmarkMid: { marginTop: -12 },
  landmarkHigh: { marginTop: -27 },
  landmarkDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: palette.faint },
  landmarkText: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    color: palette.text,
    fontSize: 12,
    fontWeight: '600',
    backgroundColor: 'rgba(10,10,11,0.78)',
    borderRadius: radius.pill,
    overflow: 'hidden',
  },

  team: { position: 'absolute', alignItems: 'center', gap: 4 },
  teamFromLeft: { flexDirection: 'row', transform: [{ translateX: -5 }, { translateY: -6 }] },
  teamFromRight: { flexDirection: 'row-reverse', transform: [{ translateX: 5 }, { translateY: -6 }] },
  teamDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: palette.faint },
  teamName: { maxWidth: 90, color: palette.text, fontSize: 8, fontWeight: '600' },

  /* A dashed ring for where the record says the team is, hollow so it can
     never be mistaken for the solid pin being placed. */
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
