import { api } from '@code2create/backend/api'
import {
  isVitHostelRoomNumber,
  normalizeParticipantName,
  normalizeParticipantPhone,
  normalizeVitHostelRoomNumberInput,
  participantGenderLabels,
  participantNameValidationError,
  participantPhoneValidationError,
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

function parseParticipantGender(value: string): ParticipantGender | null {
  switch (value) {
    case 'male':
    case 'female':
      return value
    default:
      return null
  }
}

function parseVitResidenceType(value: string): VitResidenceType | null {
  switch (value) {
    case 'day_scholar':
    case 'hosteller':
      return value
    default:
      return null
  }
}

function institutionValidationError(value: string, label: string) {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (normalized.length < 2 || (normalized.match(/\p{L}/gu) ?? []).length < 2) {
    return `Enter your ${label}.`
  }
  if (normalized.length > 160) return `Keep the ${label} under 160 characters.`
  return null
}

/** VIT identity stays verified; external participants provide their event-facing name. */
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
  const [fullName, setFullName] = useState(existing?.fullName ?? me.person.displayName)
  const [phone, setPhone] = useState(existing?.phone ?? '')
  const [fullNameTouched, setFullNameTouched] = useState(false)
  const [phoneTouched, setPhoneTouched] = useState(false)
  const [genderTouched, setGenderTouched] = useState(false)
  const [gender, setGender] = useState<ParticipantGender | ''>(existing?.gender ?? '')
  const [yearOfStudyTouched, setYearOfStudyTouched] = useState(false)
  const [yearOfStudy, setYearOfStudy] = useState<StudyYear | ''>(existing?.yearOfStudy ?? '')
  const [residenceTypeTouched, setResidenceTypeTouched] = useState(false)
  const [residenceType, setResidenceType] = useState<VitResidenceType | ''>(
    existing?.vitResidenceType ?? '',
  )
  const [hostelResidenceTouched, setHostelResidenceTouched] = useState(false)
  const [hostelResidence, setHostelResidence] = useState(existing?.vitHostelResidence ?? '')
  const [hostelRoomNumberTouched, setHostelRoomNumberTouched] = useState(false)
  const [hostelRoomNumber, setHostelRoomNumber] = useState(existing?.vitHostelRoomNumber ?? '')
  const [externalUniversityTouched, setExternalUniversityTouched] = useState(false)
  const [externalUniversity, setExternalUniversity] = useState(existing?.externalUniversity ?? '')
  const [externalCollegeTouched, setExternalCollegeTouched] = useState(false)
  const [externalCollege, setExternalCollege] = useState(existing?.externalCollege ?? '')
  const [accepted, setAccepted] = useState(me.participantPolicy.accepted)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operations = useOperationRunner()
  const savePending = operations.hasPending('profile-save')
  const acceptPending = operations.hasPending('participant-policy-accept')
  const vitStudentIdentity = membership?.participantClass === 'vit_student'
    ? membership.vitStudentIdentity
    : null
  const vitStudent = membership?.participantClass === 'vit_student'
  const fullNameError = vitStudent ? null : participantNameValidationError(fullName)
  const phoneError = participantPhoneValidationError(phone)
  const genderError = gender ? null : 'Choose your gender.'
  const yearOfStudyError = !vitStudent && !yearOfStudy ? 'Choose your year of study.' : null
  const residenceTypeError = vitStudent && !residenceType ? 'Choose your residence.' : null
  const hostelResidenceError =
    vitStudent && residenceType === 'hosteller' && !hostelResidence
      ? 'Choose your hostel block.'
      : null
  const normalizedHostelRoomNumber = normalizeVitHostelRoomNumberInput(hostelRoomNumber)
  const hostelRoomNumberError =
    vitStudent && residenceType === 'hosteller' && !isVitHostelRoomNumber(normalizedHostelRoomNumber)
      ? 'Enter a room number with 1 to 10 letters, digits, or hyphens.'
      : null
  const externalUniversityError = vitStudent
    ? null
    : institutionValidationError(externalUniversity, 'university')
  const externalCollegeError = vitStudent
    ? null
    : institutionValidationError(externalCollege, 'college')

  if (!membership) return null
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
    setFullNameTouched(true)
    setPhoneTouched(true)
    setGenderTouched(true)
    setYearOfStudyTouched(true)
    setResidenceTypeTouched(true)
    setHostelResidenceTouched(true)
    setHostelRoomNumberTouched(true)
    setExternalUniversityTouched(true)
    setExternalCollegeTouched(true)
    const submittedGender = parseParticipantGender(gender)
    const submittedYearOfStudy = parseStudyYear(yearOfStudy)
    const submittedResidenceType = parseVitResidenceType(residenceType)
    if (
      fullNameError ||
      phoneError ||
      !submittedGender ||
      (!vitStudent && (!submittedYearOfStudy || externalUniversityError || externalCollegeError)) ||
      (vitStudent && (!submittedResidenceType || hostelResidenceError || hostelRoomNumberError))
    ) {
      setError('Complete the highlighted fields before continuing.')
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
            phone: normalizeParticipantPhone(phone),
            gender: submittedGender,
            ...(!vitStudent && submittedYearOfStudy
              ? {
                  fullName: normalizeParticipantName(fullName),
                  yearOfStudy: submittedYearOfStudy,
                  externalUniversity,
                  externalCollege,
                }
              : {}),
            ...(vitStudent && submittedResidenceType
              ? {
                  vitResidenceType: submittedResidenceType,
                  ...(submittedResidenceType === 'hosteller'
                    ? {
                        vitHostelResidence: hostelResidence,
                        vitHostelRoomNumber: normalizedHostelRoomNumber,
                      }
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
          <form noValidate onSubmit={submit}>
            <fieldset disabled={disabled} className="contents">
              <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
                <PortalField
                  label="full name"
                  hint={vitStudent ? 'verified' : 'editable'}
                  error={!vitStudent && fullNameTouched ? fullNameError : null}
                >
                  {(id) => (
                    <PortalInput
                      id={id}
                      aria-invalid={!vitStudent && fullNameTouched && fullNameError !== null}
                      autoComplete="name"
                      maxLength={100}
                      minLength={2}
                      readOnly={vitStudent}
                      required={!vitStudent}
                      value={vitStudentIdentity?.fullName ?? fullName}
                      onBlur={() => {
                        if (vitStudent) return
                        setFullNameTouched(true)
                        setFullName((current) => normalizeParticipantName(current))
                      }}
                      onChange={(event) => {
                        setFullNameTouched(true)
                        setFullName(event.currentTarget.value)
                      }}
                    />
                  )}
                </PortalField>

                <PortalField label="phone" error={phoneTouched ? phoneError : null}>
                  {(id) => (
                    <PortalInput
                      id={id}
                      aria-invalid={phoneTouched && phoneError !== null}
                      autoComplete="tel"
                      inputMode="tel"
                      maxLength={24}
                      placeholder="+91 98765 43210"
                      required
                      type="tel"
                      value={phone}
                      onBlur={() => {
                        setPhoneTouched(true)
                        setPhone((current) => normalizeParticipantPhone(current))
                      }}
                      onChange={(event) => {
                        setPhoneTouched(true)
                        setPhone(event.currentTarget.value)
                      }}
                    />
                  )}
                </PortalField>

                <PortalField label="gender" error={genderTouched ? genderError : null}>
                  {(id) => (
                    <PortalSelect
                      id={id}
                      aria-invalid={genderTouched && genderError !== null}
                      value={gender}
                      onValueChange={(next) => {
                        setGenderTouched(true)
                        setGender(parseParticipantGender(next) ?? '')
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
                    <PortalField
                      label="residence"
                      error={residenceTypeTouched ? residenceTypeError : null}
                    >
                      {(id) => (
                        <PortalSelect
                          id={id}
                          aria-invalid={residenceTypeTouched && residenceTypeError !== null}
                          value={residenceType}
                          onValueChange={(next) => {
                            setResidenceTypeTouched(true)
                            setResidenceType(parseVitResidenceType(next) ?? '')
                            setHostelResidenceTouched(false)
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
                        <PortalField
                          label="hostel block"
                          error={hostelResidenceTouched ? hostelResidenceError : null}
                        >
                          {(id) => (
                            <PortalSelect
                              id={id}
                              aria-invalid={
                                hostelResidenceTouched && hostelResidenceError !== null
                              }
                              disabled={!hostelKind}
                              value={hostelResidence}
                              onValueChange={(next) => {
                                setHostelResidenceTouched(true)
                                setHostelResidence(next)
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
                        <PortalField
                          label="room number"
                          error={hostelRoomNumberTouched ? hostelRoomNumberError : null}
                        >
                          {(id) => (
                            <PortalInput
                              id={id}
                              aria-invalid={
                                hostelRoomNumberTouched && hostelRoomNumberError !== null
                              }
                              required
                              className="font-mono"
                              inputMode="text"
                              autoCapitalize="characters"
                              value={hostelRoomNumber}
                              onBlur={() => {
                                setHostelRoomNumberTouched(true)
                                setHostelRoomNumber(normalizedHostelRoomNumber)
                              }}
                              onChange={(event) => {
                                setHostelRoomNumberTouched(true)
                                setHostelRoomNumber(event.target.value)
                              }}
                            />
                          )}
                        </PortalField>
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    <PortalField
                      label="university"
                      error={externalUniversityTouched ? externalUniversityError : null}
                    >
                      {(id) => (
                        <PortalInput
                          id={id}
                          aria-invalid={
                            externalUniversityTouched && externalUniversityError !== null
                          }
                          required
                          value={externalUniversity}
                          onBlur={() => {
                            setExternalUniversityTouched(true)
                            setExternalUniversity((current) => current.trim().replace(/\s+/gu, ' '))
                          }}
                          onChange={(event) => {
                            setExternalUniversityTouched(true)
                            setExternalUniversity(event.target.value)
                          }}
                        />
                      )}
                    </PortalField>
                    <PortalField
                      label="college"
                      error={externalCollegeTouched ? externalCollegeError : null}
                    >
                      {(id) => (
                        <PortalInput
                          id={id}
                          aria-invalid={externalCollegeTouched && externalCollegeError !== null}
                          required
                          value={externalCollege}
                          onBlur={() => {
                            setExternalCollegeTouched(true)
                            setExternalCollege((current) => current.trim().replace(/\s+/gu, ' '))
                          }}
                          onChange={(event) => {
                            setExternalCollegeTouched(true)
                            setExternalCollege(event.target.value)
                          }}
                        />
                      )}
                    </PortalField>
                    <PortalField
                      label="year of study"
                      error={yearOfStudyTouched ? yearOfStudyError : null}
                    >
                      {(id) => (
                        <PortalSelect
                          id={id}
                          aria-invalid={yearOfStudyTouched && yearOfStudyError !== null}
                          value={yearOfStudy}
                          onValueChange={(next) => {
                            setYearOfStudyTouched(true)
                            const nextYear = parseStudyYear(next)
                            setYearOfStudy(nextYear ?? '')
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
                  required={!policyAlreadyAccepted}
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
