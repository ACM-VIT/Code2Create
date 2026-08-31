import { api } from '@code2create/backend/api'
import {
  participantGenderLabels,
  studyYearLabels,
  vitResidenceTypeLabels,
  type ParticipantGender,
  type VitResidenceType,
} from '@code2create/domain'
import { useMutation } from 'convex/react'
import { useState, type FormEvent } from 'react'
import { AccountBadge } from '../components/portal/AccountBadge'
import { PetalCard } from '../components/portal/PetalCard'
import { PortalButton } from '../components/portal/PortalButton'
import {
  PortalCheckRow,
  PortalError,
  PortalField,
  PortalInput,
  PortalSelect,
} from '../components/portal/PortalField'
import { PortalScene } from '../components/portal/PortalScene'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import type { ParticipantMe } from '../types'

/** The policy page on the event site; the privacy notice URL stays config-driven. */
const participantPolicyUrl = 'https://c2c.acmvit.in/policy'
const vitInstitutionName = 'Vellore Institute of Technology, Vellore'

type StudyYear = NonNullable<ParticipantMe['profile']>['yearOfStudy']

function parseStudyYear(value: string): StudyYear | null {
  switch (value) {
    case 'first':
    case 'second':
    case 'third':
    case 'fourth':
    case 'fifth_or_later':
    case 'postgraduate':
      return value
    default:
      return null
  }
}

/** Google-derived identity is read-only; participants provide event-only details. */
export function DetailsScreen({
  me,
  canWriteProfile,
  onSignOut,
}: {
  me: ParticipantMe
  canWriteProfile: boolean
  onSignOut: () => void
}) {
  const membership = me.membership
  const existing = me.profile
  const saveProfile = useMutation(api.participants.saveProfile)
  const acceptPolicy = useMutation(api.participants.acceptPolicy)
  const [phone, setPhone] = useState(existing?.phone ?? '')
  const [gender, setGender] = useState<ParticipantGender | ''>(existing?.gender ?? '')
  const [yearOfStudy, setYearOfStudy] = useState<StudyYear | ''>(existing?.yearOfStudy ?? '')
  const [residenceType, setResidenceType] = useState<VitResidenceType | ''>(
    existing?.vitResidenceType ?? '',
  )
  const [hostelResidence, setHostelResidence] = useState(existing?.vitHostelResidence ?? '')
  const [hostelRoomNumber, setHostelRoomNumber] = useState(existing?.vitHostelRoomNumber ?? '')
  const [externalUniversity, setExternalUniversity] = useState(existing?.externalUniversity ?? '')
  const [externalCollege, setExternalCollege] = useState(existing?.externalCollege ?? '')
  const [accepted, setAccepted] = useState(me.participantPolicy.accepted)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operations = useOperationRunner()
  const savePending = operations.hasPending('profile-save')
  const acceptPending = operations.hasPending('participant-policy-accept')

  if (!membership) return null
  const vitStudentIdentity = membership.participantClass === 'vit_student'
    ? membership.vitStudentIdentity
    : null
  const vitStudent = membership.participantClass === 'vit_student'
  if (vitStudent && !vitStudentIdentity) return null
  const policy = me.participantPolicy.policy
  const policyAlreadyAccepted = me.participantPolicy.accepted
  const disabled = busy || savePending
  const hostelKind = gender === 'male' ? 'mens' : gender === 'female' ? 'ladies' : null
  const visibleHostelBlocks = hostelKind
    ? policy.vitHostelResidenceCatalog.filter((residence) => residence.kind === hostelKind)
    : []

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!gender) {
      setError('Choose Male or Female.')
      return
    }
    if (!vitStudent && !yearOfStudy) {
      setError('Choose your current year of study.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (!policyAlreadyAccepted) {
        await operations.run(
          'participant-policy-accept',
          (clientOperationId) => () =>
            acceptPolicy({
              eventSlug,
              participantPolicyVersionId: me.participantPolicy.id,
              accepted,
              clientOperationId,
            }),
        )
      }
      await operations.run(
        'profile-save',
        (clientOperationId) => () =>
          saveProfile({
            eventSlug,
            participantPolicyVersionId: me.participantPolicy.id,
            phone,
            gender,
            ...(!vitStudent && yearOfStudy
              ? { yearOfStudy, externalUniversity, externalCollege }
              : {}),
            ...(vitStudent && residenceType
              ? {
                  vitResidenceType: residenceType,
                  ...(residenceType === 'hosteller'
                    ? { vitHostelResidence: hostelResidence, vitHostelRoomNumber: hostelRoomNumber }
                    : {}),
                }
              : {}),
            expectedProfileVersion: existing?.profileVersion ?? 0,
            clientOperationId,
          }),
      )
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <AccountBadge
      name={me.person.displayName}
      email={me.person.verifiedEmail}
      detail={vitStudent ? 'VIT student' : 'external participant'}
      onSignOut={onSignOut}
    />
  )

  if (!canWriteProfile) {
    return (
      <PortalScene tree="right" header={header}>
        <div className="w-full max-w-[560px]">
          <PetalCard className="px-8 py-7">
            <h1 className="mb-3 font-display font-light tracking-[-.01em] text-3xl">
              Profile editing is unavailable.
            </h1>
            <p className="text-[13px] text-fg/60">Ask an organizer if this looks wrong.</p>
          </PetalCard>
        </div>
      </PortalScene>
    )
  }

  return (
    <PortalScene tree="right" header={header}>
      <div className="flex w-full max-w-[640px] flex-col items-center">
        <h1 className="mb-7 text-center font-display font-normal tracking-[-.01em] text-3xl text-shadow-[0_4px_30px_var(--scene-text-glow)] lg:text-[40px]">
          A few details, once.
        </h1>

        <PetalCard className="px-6 pt-6 pb-4 lg:px-[30px]">
          <form onSubmit={submit}>
            <fieldset disabled={disabled} className="contents">
              <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
                <PortalField label="full name" hint="from Google">
                  {(id) => (
                    <PortalInput
                      id={id}
                      readOnly
                      value={vitStudentIdentity?.fullName ?? me.person.displayName}
                    />
                  )}
                </PortalField>

                <PortalField label="phone">
                  {(id) => (
                    <PortalInput
                      id={id}
                      inputMode="tel"
                      minLength={7}
                      required
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                    />
                  )}
                </PortalField>

                <PortalField label="gender">
                  {(id) => (
                    <PortalSelect
                      id={id}
                      required
                      value={gender}
                      onChange={(event) => {
                        const nextGender = event.target.value as ParticipantGender | ''
                        setGender(nextGender)
                        setHostelResidence('')
                        setHostelRoomNumber('')
                      }}
                    >
                      <option value="">Select gender</option>
                      <option value="male">{participantGenderLabels.male}</option>
                      <option value="female">{participantGenderLabels.female}</option>
                    </PortalSelect>
                  )}
                </PortalField>

                {vitStudentIdentity ? (
                  <>
                    <PortalField label="college or university" hint="fixed">
                      {(id) => <PortalInput id={id} readOnly value={vitInstitutionName} />}
                    </PortalField>
                    <PortalField label="year of study" hint="auto">
                      {(id) => (
                        <PortalInput
                          id={id}
                          readOnly
                          value={studyYearLabels[vitStudentIdentity.yearOfStudy]}
                        />
                      )}
                    </PortalField>
                    <PortalField label="registration number" hint="verified">
                      {(id) => (
                        <PortalInput
                          id={id}
                          className="font-mono"
                          readOnly
                          value={vitStudentIdentity.registrationNumber}
                        />
                      )}
                    </PortalField>
                    <PortalField label="programme code" hint="auto">
                      {(id) => (
                        <PortalInput id={id} readOnly value={vitStudentIdentity.programmeCode} />
                      )}
                    </PortalField>
                    <PortalField label="residence">
                      {(id) => (
                        <PortalSelect
                          id={id}
                          required
                          value={residenceType}
                          onChange={(event) => {
                            const nextType = event.target.value as VitResidenceType | ''
                            setResidenceType(nextType)
                            setHostelResidence('')
                            setHostelRoomNumber('')
                          }}
                        >
                          <option value="">Select residence</option>
                          <option value="day_scholar">
                            {vitResidenceTypeLabels.day_scholar}
                          </option>
                          <option value="hosteller">{vitResidenceTypeLabels.hosteller}</option>
                        </PortalSelect>
                      )}
                    </PortalField>
                    {residenceType === 'hosteller' ? (
                      <>
                        <PortalField label="hostel block">
                          {(id) => (
                            <PortalSelect
                              id={id}
                              required
                              disabled={!hostelKind}
                              value={hostelResidence}
                              onChange={(event) => {
                                setHostelResidence(event.target.value)
                                setHostelRoomNumber('')
                              }}
                            >
                              <option value="">
                                {hostelKind ? 'Select hostel block' : 'Select gender first'}
                              </option>
                              {visibleHostelBlocks.map((residence) => (
                                <option key={residence.stableKey} value={residence.stableKey}>
                                  {residence.label}
                                </option>
                              ))}
                            </PortalSelect>
                          )}
                        </PortalField>
                        <PortalField label="room number">
                          {(id) => (
                            <PortalInput
                              id={id}
                              required
                              className="font-mono"
                              inputMode="text"
                              autoCapitalize="characters"
                              value={hostelRoomNumber}
                              onChange={(event) => setHostelRoomNumber(event.target.value)}
                            />
                          )}
                        </PortalField>
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    <PortalField label="university">
                      {(id) => (
                        <PortalInput
                          id={id}
                          required
                          value={externalUniversity}
                          onChange={(event) => setExternalUniversity(event.target.value)}
                        />
                      )}
                    </PortalField>
                    <PortalField label="college">
                      {(id) => (
                        <PortalInput
                          id={id}
                          required
                          value={externalCollege}
                          onChange={(event) => setExternalCollege(event.target.value)}
                        />
                      )}
                    </PortalField>
                    <PortalField label="year of study">
                      {(id) => (
                        <PortalSelect
                          id={id}
                          required
                          value={yearOfStudy}
                          onChange={(event) => {
                            const nextYear = parseStudyYear(event.target.value)
                            if (nextYear) setYearOfStudy(nextYear)
                          }}
                        >
                          <option value="">Select year of study</option>
                          <option value="first">First year</option>
                          <option value="second">Second year</option>
                          <option value="third">Third year</option>
                          <option value="fourth">Fourth year</option>
                          <option value="fifth_or_later">Fifth year or later</option>
                          <option value="postgraduate">Postgraduate</option>
                        </PortalSelect>
                      )}
                    </PortalField>
                  </>
                )}
              </div>

              <div className="mt-4.5 border-t border-petal-line pt-4">
                <PortalCheckRow
                  checked={accepted}
                  disabled={policyAlreadyAccepted || disabled}
                  onChange={setAccepted}
                >
                  I accept the{' '}
                  <a
                    href={participantPolicyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-rose-light underline decoration-rose-light/50 decoration-1 underline-offset-2 transition-colors hover:decoration-rose-light"
                  >
                    participant policy
                  </a>{' '}
                  and the{' '}
                  <a
                    href={policy.privacyNoticeUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-rose-light underline decoration-rose-light/50 decoration-1 underline-offset-2 transition-colors hover:decoration-rose-light"
                  >
                    privacy notice
                  </a>
                </PortalCheckRow>
                <p className="mt-2 pl-6 text-[11.5px] text-fg/45">{policy.profileNotice}</p>
              </div>
            </fieldset>

            <PortalError message={error} />

            <div className="mt-3.5 flex items-center justify-between border-t border-petal-line pt-3.5">
              <span className="text-xs text-fg/45">
                {savePending ? 'confirming your earlier save' : 'saved when you continue'}
              </span>
              <PortalButton type="submit" size="sm" disabled={disabled || !accepted}>
                {busy ? 'Saving…' : savePending || acceptPending ? 'Confirm' : 'Continue'}
              </PortalButton>
            </div>
          </form>
        </PetalCard>
      </div>
    </PortalScene>
  )
}
