import { api } from '@code2create/backend/api'
import type { FunctionReturnType } from 'convex/server'
import { useAction, useQuery } from 'convex/react'
import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { countdownName } from '../lib/time'
import { AttendanceResultHistory } from './AttendanceResultHistory'

type PortalQr = {
  tokenId: FunctionReturnType<typeof api.attendanceActions.mintPortalQr>['tokenId']
  payload: string
  expiresAt: number
  serverNow: number
  clientNow: number
}

type ParticipantAttendance = FunctionReturnType<typeof api.attendanceParticipant.mine>
type PhysicalCredential = ParticipantAttendance['physicalCredential']
type VenueCheckIn = ParticipantAttendance['venueCheckIn']
type VenueState = NonNullable<ParticipantAttendance['venue']>['state']
type SessionState = ParticipantAttendance['sessions'][number]['state']

export function AttendancePanel() {
  const attendance = useQuery(api.attendanceParticipant.mine, { eventSlug })
  const mintPortalQr = useAction(api.attendanceActions.mintPortalQr)
  const mintingRef = useRef(false)
  const [portalQr, setPortalQr] = useState<PortalQr | null>(null)
  const [now, setNow] = useState(() => performance.now())
  const [error, setError] = useState<string | null>(null)
  const [minting, setMinting] = useState(false)
  const portalQrState = useQuery(
    api.attendanceParticipant.portalQrState,
    portalQr ? { eventSlug, tokenId: portalQr.tokenId } : 'skip',
  )

  const mint = useCallback(async () => {
    if (!attendance?.canMintPortalQr || mintingRef.current) return
    mintingRef.current = true
    setMinting(true)
    setError(null)
    try {
      const next = await mintPortalQr({ eventSlug })
      const clientNow = performance.now()
      setPortalQr({
        tokenId: next.tokenId,
        payload: next.payload,
        expiresAt: next.expiresAt,
        serverNow: next.serverNow,
        clientNow,
      })
      setNow(clientNow)
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      mintingRef.current = false
      setMinting(false)
    }
  }, [attendance?.canMintPortalQr, mintPortalQr])

  useEffect(() => {
    if (!portalQr) return
    const timer = window.setInterval(() => {
      const nextNow = performance.now()
      setNow(nextNow)
      const nextServerNow = portalQr.serverNow + nextNow - portalQr.clientNow
      if (nextServerNow >= portalQr.expiresAt) window.clearInterval(timer)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [portalQr])

  if (attendance === undefined) {
    return null
  }
  if (!attendance.available) return null

  const qrServerNow = portalQr ? portalQr.serverNow + now - portalQr.clientNow : 0
  const secondsLeft = portalQr
    ? Math.max(0, Math.ceil((portalQr.expiresAt - qrServerNow) / 1_000))
    : 0
  const tokenIsActive = portalQrState === undefined || portalQrState?.state === 'active'
  const currentQr = attendance.canMintPortalQr && tokenIsActive && portalQr && secondsLeft > 0
    ? portalQr
    : null
  const usesVitId = attendance.physicalCredential.kind === 'vit_id_barcode'

  return (
    <section className="attendance-panel" aria-labelledby="attendance-heading">
      <div>
        <p className="eyebrow">At the event</p>
        <h2 id="attendance-heading">Check-in</h2>
      </div>
      <dl className="detail-list compact-details">
        <div>
          <dt>Event arrival</dt>
          <dd>{venueCheckInName(attendance.venueCheckIn)}</dd>
        </div>
        {attendance.venueCheckIn ? (
          <div>
            <dt>Current location</dt>
            <dd>{venueStateName(attendance.venue?.state ?? 'not_arrived')}</dd>
          </div>
        ) : null}
        {attendance.sessions.map((session) => (
          <div key={session.id}>
            <dt>{session.timing === 'current' ? session.name : `Next · ${session.name}`}</dt>
            <dd>
              {session.timing === 'current'
                ? `${sessionStateName(session.state)} · ${session.zoneName}`
                : `${sessionTimeName(session.startsAt)} · ${session.zoneName}`}
            </dd>
          </div>
        ))}
        <div>
          <dt>{attendance.physicalCredential.kind === 'vit_id_barcode' ? 'VIT ID' : 'Event badge'}</dt>
          <dd>{physicalCredentialName(attendance.physicalCredential)}</dd>
        </div>
      </dl>
      <p className="attendance-credential-note">
        {credentialInstruction(attendance.physicalCredential)}
      </p>
      {currentQr ? (
        <div className="portal-qr">
          <div className="qr-surface">
            <QRCodeSVG
              bgColor="#f1eee8"
              fgColor="#0a0a09"
              level="M"
              marginSize={2}
              size={220}
              title="Your short-lived Code2Create attendance code"
              value={currentQr.payload}
            />
          </div>
          <p className="inline-status">Expires in {countdownName(secondsLeft)} · Show this only to event staff.</p>
          <button type="button" className="text-button" disabled={minting} onClick={() => void mint()}>
            {minting ? 'Refreshing…' : 'Refresh code'}
          </button>
        </div>
      ) : attendance.canMintPortalQr ? (
        <button type="button" className="secondary" disabled={minting} onClick={() => void mint()}>
          {minting ? 'Creating code…' : usesVitId ? 'Show backup check-in code' : 'Show check-in code'}
        </button>
      ) : null}
      {attendance.canReadResultHistory ? <AttendanceResultHistory /> : null}
      {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
    </section>
  )
}

function physicalCredentialName(credential: PhysicalCredential) {
  if (credential.kind === 'vit_id_barcode') {
    if (credential.state === 'active') return 'Linked'
    if (credential.state === 'suspended') return 'Needs staff help'
    return 'Link at first check-in'
  }
  if (credential.state === 'active') return `Active · ${credential.badgeReference}`
  if (credential.state === 'revoked') return 'Revoked · ask event staff for a replacement'
  return 'Collect at first check-in'
}

function credentialInstruction(credential: PhysicalCredential) {
  if (credential.kind === 'vit_id_barcode') {
    if (credential.state === 'not_enrolled') {
      return 'Bring your VIT ID. Staff will scan and link its printed barcode at your first check-in.'
    }
    if (credential.state === 'active') {
      return 'Bring your VIT ID. Staff scan its printed barcode when you enter or leave.'
    }
    return 'Your VIT ID barcode is unavailable. Ask event staff or use the backup code below.'
  }
  if (credential.state === 'active') return 'Staff scan your event badge when you enter or leave.'
  if (credential.state === 'revoked') return 'Ask event staff for a replacement badge.'
  return 'Show the code below at first check-in. Staff will issue your event badge.'
}

function venueStateName(state: VenueState) {
  if (state === 'inside') return 'Inside'
  if (state === 'temporarily_out') return 'Temporarily out'
  if (state === 'departed') return 'Departed'
  if (state === 'unknown') return 'Needs review'
  return 'Not arrived'
}

function venueCheckInName(checkIn: VenueCheckIn) {
  if (!checkIn) return 'Not checked in'
  if (checkIn.status === 'reversed') return 'Check-in reversed · see event staff'
  return `Checked in · ${new Date(checkIn.checkedInAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`
}

function sessionStateName(state: SessionState) {
  if (state === 'confirmation_due') return 'Confirmation due'
  if (state === 'present') return 'Present'
  if (state === 'temporarily_out') return 'Temporarily out'
  if (state === 'complete') return 'Complete'
  if (state === 'excused') return 'Excused'
  if (state === 'needs_review') return 'Needs review'
  return 'Not expected'
}

function sessionTimeName(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp)
}
