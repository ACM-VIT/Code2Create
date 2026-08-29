import { api } from '@code2create/backend/api'
import { studyYearLabels } from '@code2create/domain'
import { useMutation } from 'convex/react'
import { useState, type FormEvent } from 'react'
import { ErrorNotice, Field, Select, TextInput } from '../components/Form'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'
import type { ParticipantMe } from '../types'

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

export function ProfileScreen({ me }: { me: ParticipantMe }) {
  const membership = me.membership
  const existing = me.profile
  const saveProfile = useMutation(api.participants.saveProfile)
  const [fullName, setFullName] = useState(existing?.fullName ?? me.person.displayName)
  const [preferredName, setPreferredName] = useState(existing?.preferredName ?? '')
  const [phone, setPhone] = useState(existing?.phone ?? '')
  const [institution, setInstitution] = useState(existing?.institution ?? '')
  const [yearOfStudy, setYearOfStudy] = useState(existing?.yearOfStudy ?? 'first')
  const [currentRole, setCurrentRole] = useState(existing?.currentRole ?? '')
  const [campus, setCampus] = useState(existing?.vitCampus ?? '')
  const [externalCity, setExternalCity] = useState(existing?.externalCity ?? '')
  const [externalCountry, setExternalCountry] = useState(existing?.externalCountry ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operations = useOperationRunner()
  const savePending = operations.hasPending('profile-save')

  if (!membership) return null
  const vitStudentIdentity = membership.participantClass === 'vit_student'
    ? membership.vitStudentIdentity
    : null
  const vitStudent = vitStudentIdentity !== null
  const policy = me.participantPolicy.policy

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await operations.run('profile-save', (clientOperationId) => () => saveProfile({
        eventSlug,
        participantPolicyVersionId: me.participantPolicy.id,
        ...(!vitStudent ? { fullName } : {}),
        ...(preferredName ? { preferredName } : {}),
        ...(policy.phoneField !== 'not_collected' && phone ? { phone } : {}),
        ...(!vitStudent ? { institution, yearOfStudy } : {}),
        ...(!vitStudent && yearOfStudy === 'not_applicable' && currentRole ? { currentRole } : {}),
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
      }))
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="centered-shell top-aligned">
      <section className="form-panel">
        <p className="muted">Your profile</p>
        <h1>A few basics.</h1>
        <form onSubmit={submit} className="form-grid">
          <fieldset disabled={busy || savePending} style={{ display: 'contents' }}>
          {vitStudent ? (
            <Field label="Full name" hint="Verified by your VIT Google account">
              <TextInput readOnly value={vitStudentIdentity.fullName} />
            </Field>
          ) : (
            <Field label="Full name">
              <TextInput required value={fullName} onChange={(event) => setFullName(event.target.value)} />
            </Field>
          )}
          <Field label="Name we should show" hint="Optional">
            <TextInput value={preferredName} onChange={(event) => setPreferredName(event.target.value)} />
          </Field>
          {policy.phoneField !== 'not_collected' ? (
            <Field label="Phone" {...(policy.phoneField === 'optional' ? { hint: 'Optional' } : {})}>
              <TextInput required={policy.phoneField === 'required'} inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
            </Field>
          ) : null}
          {vitStudent ? (
            <Field label="College or university" hint="Set from your verified VIT email">
              <TextInput readOnly value="Vellore Institute of Technology" />
            </Field>
          ) : (
            <Field label="College, university, or organisation">
              <TextInput required value={institution} onChange={(event) => setInstitution(event.target.value)} />
            </Field>
          )}
          {vitStudent ? (
            <Field label="Year of study" hint="Derived from your VIT registration number">
              <TextInput readOnly value={studyYearLabels[vitStudentIdentity.yearOfStudy]} />
            </Field>
          ) : (
            <Field label="Year of study">
              <Select
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
              </Select>
            </Field>
          )}
          {!vitStudent && yearOfStudy === 'not_applicable' ? (
            <Field label="Current role">
              <TextInput required value={currentRole} onChange={(event) => setCurrentRole(event.target.value)} />
            </Field>
          ) : null}
          {vitStudent ? (
            <>
              {policy.vitRegistrationNumberField !== 'not_collected' ? (
                <Field label="VIT registration number" hint="Verified from your VIT Google account">
                  <TextInput readOnly value={vitStudentIdentity.registrationNumber} />
                </Field>
              ) : null}
              {policy.vitProgrammeField !== 'not_collected' ? (
                <Field label="Programme code" hint="Derived from your VIT registration number">
                  <TextInput readOnly value={vitStudentIdentity.programmeCode} />
                </Field>
              ) : null}
              {policy.vitCampusField !== 'not_collected' ? (
                <Field label="Campus" {...(policy.vitCampusField === 'optional' ? { hint: 'Optional' } : {})}>
                  <TextInput required={policy.vitCampusField === 'required'} value={campus} onChange={(event) => setCampus(event.target.value)} />
                </Field>
              ) : null}
            </>
          ) : (
            <>
              {policy.externalCityField !== 'not_collected' ? (
                <Field label="City" {...(policy.externalCityField === 'optional' ? { hint: 'Optional' } : {})}>
                  <TextInput required={policy.externalCityField === 'required'} value={externalCity} onChange={(event) => setExternalCity(event.target.value)} />
                </Field>
              ) : null}
              {policy.externalCountryField !== 'not_collected' ? (
                <Field label="Country" {...(policy.externalCountryField === 'optional' ? { hint: 'Optional' } : {})}>
                  <TextInput required={policy.externalCountryField === 'required'} value={externalCountry} onChange={(event) => setExternalCountry(event.target.value)} />
                </Field>
              ) : null}
            </>
          )}
          <div className="form-span policy-copy">
            <p>{policy.profileNotice}</p>
            <a href={policy.privacyNoticeUrl} target="_blank" rel="noreferrer">Read the privacy notice</a>
          </div>
          </fieldset>
          <ErrorNotice message={error} />
          <div className="form-actions form-span">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving…' : savePending ? 'Confirm earlier profile' : 'Save and continue'}
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}
