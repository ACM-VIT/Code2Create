import { api } from '@code2create/backend/api'
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
  const [registrationNumber, setRegistrationNumber] = useState(existing?.vitRegistrationNumber ?? '')
  const [programme, setProgramme] = useState(existing?.vitProgramme ?? '')
  const [campus, setCampus] = useState(existing?.vitCampus ?? '')
  const [externalCity, setExternalCity] = useState(existing?.externalCity ?? '')
  const [externalCountry, setExternalCountry] = useState(existing?.externalCountry ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operations = useOperationRunner()
  const savePending = operations.hasPending('profile-save')

  if (!membership) return null
  const vitStudent = membership.participantClass === 'vit_student'
  const policy = me.participantPolicy.policy

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await operations.run('profile-save', (clientOperationId) => () => saveProfile({
        eventSlug,
        participantPolicyVersionId: me.participantPolicy.id,
        fullName,
        ...(preferredName ? { preferredName } : {}),
        ...(policy.phoneField !== 'not_collected' && phone ? { phone } : {}),
        institution,
        yearOfStudy,
        ...(!vitStudent && yearOfStudy === 'not_applicable' && currentRole ? { currentRole } : {}),
        ...(vitStudent && policy.vitRegistrationNumberField !== 'not_collected' && registrationNumber
          ? { vitRegistrationNumber: registrationNumber }
          : {}),
        ...(vitStudent && policy.vitProgrammeField !== 'not_collected' && programme
          ? { vitProgramme: programme }
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
          <Field label="Full name">
            <TextInput required value={fullName} onChange={(event) => setFullName(event.target.value)} />
          </Field>
          <Field label="Name we should show" hint="Optional">
            <TextInput value={preferredName} onChange={(event) => setPreferredName(event.target.value)} />
          </Field>
          {policy.phoneField !== 'not_collected' ? (
            <Field label="Phone" {...(policy.phoneField === 'optional' ? { hint: 'Optional' } : {})}>
              <TextInput required={policy.phoneField === 'required'} inputMode="tel" value={phone} onChange={(event) => setPhone(event.target.value)} />
            </Field>
          ) : null}
          <Field label={vitStudent ? 'College or university' : 'College, university, or organisation'}>
            <TextInput required value={institution} onChange={(event) => setInstitution(event.target.value)} />
          </Field>
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
              {!vitStudent ? <option value="not_applicable">Not a student</option> : null}
            </Select>
          </Field>
          {!vitStudent && yearOfStudy === 'not_applicable' ? (
            <Field label="Current role">
              <TextInput required value={currentRole} onChange={(event) => setCurrentRole(event.target.value)} />
            </Field>
          ) : null}
          {vitStudent ? (
            <>
              {policy.vitRegistrationNumberField !== 'not_collected' ? (
                <Field label="VIT registration number" {...(policy.vitRegistrationNumberField === 'optional' ? { hint: 'Optional' } : {})}>
                  <TextInput required={policy.vitRegistrationNumberField === 'required'} value={registrationNumber} onChange={(event) => setRegistrationNumber(event.target.value)} />
                </Field>
              ) : null}
              {policy.vitProgrammeField !== 'not_collected' ? (
                <Field label="Programme" {...(policy.vitProgrammeField === 'optional' ? { hint: 'Optional' } : {})}>
                  <TextInput required={policy.vitProgrammeField === 'required'} value={programme} onChange={(event) => setProgramme(event.target.value)} />
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
