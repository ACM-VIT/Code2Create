import { api } from '@code2create/backend/api'
import { studyYearLabels } from '@code2create/domain'
import { useMutation } from 'convex/react'
import { useState, type FormEvent } from 'react'
import { PortalScene } from '../components/portal/PortalScene'
import { PetalCard } from '../components/portal/PetalCard'
import { PortalButton } from '../components/portal/PortalButton'
import { AccountBadge } from '../components/portal/AccountBadge'
import {
  PortalCheckRow,
  PortalError,
  PortalField,
  PortalInput,
  PortalSelect,
} from '../components/portal/PortalField'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import type { ParticipantMe } from '../types'

/** The policy page on the event site; the privacy notice URL stays config-driven. */
const participantPolicyUrl = 'https://c2c.acmvit.in/policy'

type StudyYear = NonNullable<ParticipantMe['profile']>['yearOfStudy']

function parseStudyYear(value: string): StudyYear | null {
  switch (value) {
    case 'first':
    case 'second':
    case 'third':
    case 'fourth':
    case 'fifth_or_later':
    case 'postgraduate':
    case 'not_applicable':
      return value
    default:
      return null
  }
}

/**
 * Onboarding step two (mockup f0b): the details Google cannot tell us, with
 * policy consent inline. Accepting the policy and saving the profile are two
 * independent idempotent commands behind one Continue, so a partial failure
 * retries cleanly.
 */
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
  const [preferredName, setPreferredName] = useState(existing?.preferredName ?? '')
  const [phone, setPhone] = useState(existing?.phone ?? '')
  const [institution, setInstitution] = useState(existing?.institution ?? '')
  const [yearOfStudy, setYearOfStudy] = useState(existing?.yearOfStudy ?? 'first')
  const [currentRole, setCurrentRole] = useState(existing?.currentRole ?? '')
  const [campus, setCampus] = useState(existing?.vitCampus ?? '')
  const [externalCity, setExternalCity] = useState(existing?.externalCity ?? '')
  const [externalCountry, setExternalCountry] = useState(existing?.externalCountry ?? '')
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

  const submit = async (event: FormEvent) => {
    event.preventDefault()
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
            ...(!vitStudent ? { fullName } : {}),
            ...(preferredName ? { preferredName } : {}),
            ...(policy.phoneField !== 'not_collected' && phone ? { phone } : {}),
            ...(!vitStudent ? { institution, yearOfStudy } : {}),
            ...(!vitStudent && yearOfStudy === 'not_applicable' && currentRole
              ? { currentRole }
              : {}),
            ...(vitStudent && policy.vitCampusField !== 'not_collected' && campus
              ? { vitCampus: campus }
              : {}),
            ...(!vitStudent && policy.externalCityField !== 'not_collected' && externalCity
              ? { externalCity }
              : {}),
            ...(!vitStudent && policy.externalCountryField !== 'not_collected' && externalCountry
              ? { externalCountry }
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
        <PetalCard className="max-w-[560px] px-8 py-7">
          <h1 className="mb-3 font-display font-light tracking-[-.01em] text-3xl">Profile editing is unavailable.</h1>
          <p className="text-[13px] text-fg/60">
            Ask an organizer if this looks wrong.
          </p>
        </PetalCard>
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
                {vitStudentIdentity ? (
                  <PortalField label="full name" hint="verified">
                    {(id) => <PortalInput id={id} readOnly value={vitStudentIdentity.fullName} />}
                  </PortalField>
                ) : (
                  <PortalField label="full name">
                    {(id) => (
                      <PortalInput
                        id={id}
                        required
                        value={fullName}
                        onChange={(event) => setFullName(event.target.value)}
                      />
                    )}
                  </PortalField>
                )}
                <PortalField label="preferred name" hint="optional">
                  {(id) => (
                    <PortalInput
                      id={id}
                      placeholder="what should we call you?"
                      value={preferredName}
                      onChange={(event) => setPreferredName(event.target.value)}
                    />
                  )}
                </PortalField>

                {policy.phoneField !== 'not_collected' ? (
                  <PortalField
                    label="phone"
                    {...(policy.phoneField === 'optional' ? { hint: 'optional' } : {})}
                  >
                    {(id) => (
                      <PortalInput
                        id={id}
                        inputMode="tel"
                        required={policy.phoneField === 'required'}
                        value={phone}
                        onChange={(event) => setPhone(event.target.value)}
                      />
                    )}
                  </PortalField>
                ) : null}

                {vitStudentIdentity ? (
                  <PortalField label="college or university" hint="verified">
                    {(id) => <PortalInput id={id} readOnly value="Vellore Institute of Technology" />}
                  </PortalField>
                ) : (
                  <PortalField label="college, university, or organisation">
                    {(id) => (
                      <PortalInput
                        id={id}
                        required
                        value={institution}
                        onChange={(event) => setInstitution(event.target.value)}
                      />
                    )}
                  </PortalField>
                )}

                {vitStudentIdentity ? (
                  <PortalField label="year of study" hint="auto">
                    {(id) => (
                      <PortalInput
                        id={id}
                        readOnly
                        value={studyYearLabels[vitStudentIdentity.yearOfStudy]}
                      />
                    )}
                  </PortalField>
                ) : (
                  <PortalField label="year of study">
                    {(id) => (
                      <PortalSelect
                        id={id}
                        value={yearOfStudy}
                        onChange={(event) => {
                          const nextYear = parseStudyYear(event.target.value)
                          if (nextYear) setYearOfStudy(nextYear)
                        }}
                      >
                        <option value="first">First year</option>
                        <option value="second">Second year</option>
                        <option value="third">Third year</option>
                        <option value="fourth">Fourth year</option>
                        <option value="fifth_or_later">Fifth year or later</option>
                        <option value="postgraduate">Postgraduate</option>
                        <option value="not_applicable">Not a student</option>
                      </PortalSelect>
                    )}
                  </PortalField>
                )}

                {!vitStudent && yearOfStudy === 'not_applicable' ? (
                  <PortalField label="current role">
                    {(id) => (
                      <PortalInput
                        id={id}
                        required
                        value={currentRole}
                        onChange={(event) => setCurrentRole(event.target.value)}
                      />
                    )}
                  </PortalField>
                ) : null}

                {vitStudentIdentity ? (
                  <>
                    {policy.vitRegistrationNumberField !== 'not_collected' ? (
                      <PortalField
                        label="registration number"
                        hint="verified"
                      >
                        {(id) => (
                          <PortalInput
                            id={id}
                            className="font-mono"
                            readOnly
                            value={vitStudentIdentity.registrationNumber}
                          />
                        )}
                      </PortalField>
                    ) : null}
                    {policy.vitProgrammeField !== 'not_collected' ? (
                      <PortalField
                        label="programme code"
                        hint="auto"
                      >
                        {(id) => (
                          <PortalInput
                            id={id}
                            readOnly
                            value={vitStudentIdentity.programmeCode}
                          />
                        )}
                      </PortalField>
                    ) : null}
                    {policy.vitCampusField !== 'not_collected' ? (
                      <PortalField
                        label="campus"
                        {...(policy.vitCampusField === 'optional' ? { hint: 'optional' } : {})}
                      >
                        {(id) => (
                          <PortalInput
                            id={id}
                            required={policy.vitCampusField === 'required'}
                            value={campus}
                            onChange={(event) => setCampus(event.target.value)}
                          />
                        )}
                      </PortalField>
                    ) : null}
                  </>
                ) : (
                  <>
                    {policy.externalCityField !== 'not_collected' ? (
                      <PortalField
                        label="city"
                        {...(policy.externalCityField === 'optional' ? { hint: 'optional' } : {})}
                      >
                        {(id) => (
                          <PortalInput
                            id={id}
                            required={policy.externalCityField === 'required'}
                            value={externalCity}
                            onChange={(event) => setExternalCity(event.target.value)}
                          />
                        )}
                      </PortalField>
                    ) : null}
                    {policy.externalCountryField !== 'not_collected' ? (
                      <PortalField
                        label="country"
                        {...(policy.externalCountryField === 'optional' ? { hint: 'optional' } : {})}
                      >
                        {(id) => (
                          <PortalInput
                            id={id}
                            required={policy.externalCountryField === 'required'}
                            value={externalCountry}
                            onChange={(event) => setExternalCountry(event.target.value)}
                          />
                        )}
                      </PortalField>
                    ) : null}
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
                <p className="mt-2 pl-6 text-[11.5px] text-fg/45">
                  {policy.profileNotice}
                </p>
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
