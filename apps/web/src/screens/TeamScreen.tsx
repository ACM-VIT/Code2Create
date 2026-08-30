import { api } from '@code2create/backend/api'
import { useMutation } from 'convex/react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PortalScene } from '../components/portal/PortalScene'
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import { PortalError, PortalInput, PortalLabel } from '../components/portal/PortalField'
import { Petal } from '../components/portal/Petal'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'

function TeamCard({
  featured = false,
  icon,
  title,
  detail,
  children,
}: {
  featured?: boolean
  icon: ReactNode
  title: string
  detail: string
  children: ReactNode
}) {
  return (
    <div
      className={`flex w-full flex-col rounded-petal-sm px-7 py-6 text-left backdrop-blur-md sm:w-[300px] ${
        featured
          ? 'border-[1.5px] border-rose-light bg-[linear-gradient(155deg,rgba(255,255,255,.1),rgba(12,0,4,.55)_60%)] shadow-[0_28px_56px_-20px_rgba(0,0,0,.85),0_0_26px_rgba(216,132,162,.25)]'
          : 'border border-petal-edge-soft bg-[linear-gradient(155deg,rgba(255,255,255,.06),rgba(12,0,4,.48)_60%)] shadow-[0_28px_56px_-20px_rgba(0,0,0,.85)]'
      }`}
    >
      <div className="mb-3">{icon}</div>
      <p
        className={`mb-1.5 font-display font-light tracking-[-.01em] text-[21px] ${
          featured ? 'text-rose-light' : 'text-[rgb(248_248_248/.85)]'
        }`}
      >
        {title}
      </p>
      <p className="mb-4.5 flex-1 text-[12.5px] leading-relaxed text-[rgb(248_248_248/.6)]">
        {detail}
      </p>
      {children}
    </div>
  )
}

const joinIcon = (
  <svg
    width="26"
    height="26"
    viewBox="0 0 24 24"
    fill="none"
    stroke="rgb(254 180 203 / .8)"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden
  >
    <circle cx="9" cy="8.5" r="3" />
    <path d="M3.5 19c.4-3 2.6-4.7 5.5-4.7s5.1 1.7 5.5 4.7" />
    <path d="M16 6.2a2.6 2.6 0 0 1 0 4.9M17.5 14.6c1.8.5 3 1.9 3.3 4" />
  </svg>
)

/** Onboarding step three (mockup f0c): create a team, or join with a code. */
export function TeamScreen({ header }: { header?: ReactNode }) {
  const params = useParams<{ code?: string }>()
  const navigate = useNavigate()
  const createTeam = useMutation(api.teams.create)
  const joinTeam = useMutation(api.teams.join)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [code, setCode] = useState(params.code ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operations = useOperationRunner()
  const createPending = operations.hasPending('team-create')
  const joinPending = operations.hasPending('team-join')
  const operationPending = createPending || joinPending

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await operations.run(
        'team-create',
        (clientOperationId) => () => createTeam({ eventSlug, name, clientOperationId }),
      )
      navigate('/', { replace: true })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  const join = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await operations.run(
        'team-join',
        (clientOperationId) => () => joinTeam({ eventSlug, code, clientOperationId }),
      )
      navigate('/', { replace: true })
    } catch (caught) {
      setError(readableError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PortalScene tree="left" {...(header ? { header } : {})}>
      <div className="flex w-full max-w-[660px] flex-col items-center text-center">
        <h1 className="mb-2 font-display font-normal tracking-[-.01em] text-3xl text-shadow-[0_4px_30px_rgba(0,0,0,.55)] lg:text-[42px]">
          Find your people.
        </h1>
        <p className="mb-8 text-[12.5px] text-[rgb(248_248_248/.5)]">
          one team per participant · you can switch until you submit
        </p>

        <div className="flex w-full flex-col items-stretch gap-4 sm:flex-row sm:justify-center sm:gap-[18px]">
          <TeamCard
            featured
            icon={<Petal size={26} />}
            title="Create a team"
            detail="you become the lead"
          >
            {naming ? (
              <form onSubmit={create}>
                <PortalLabel>team name</PortalLabel>
                <PortalInput
                  autoFocus
                  required
                  maxLength={80}
                  disabled={operationPending || busy}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="e.g. Paper Cranes"
                />
                <div className="mt-3 flex items-center justify-between gap-3">
                  <PortalTextButton
                    type="button"
                    disabled={operationPending || busy}
                    onClick={() => {
                      setNaming(false)
                      setError(null)
                    }}
                  >
                    back
                  </PortalTextButton>
                  <PortalButton
                    type="submit"
                    size="sm"
                    disabled={busy || joinPending || (!createPending && !name.trim())}
                  >
                    {busy ? 'Creating…' : createPending ? 'Confirm' : 'Create'}
                  </PortalButton>
                </div>
              </form>
            ) : (
              <PortalButton
                type="button"
                size="sm"
                className="w-full"
                disabled={operationPending || busy}
                onClick={() => {
                  setNaming(true)
                  setError(null)
                }}
              >
                Start one
              </PortalButton>
            )}
          </TeamCard>

          <TeamCard icon={joinIcon} title="Join a team" detail="paste the code your lead shared">
            <form onSubmit={join} className="flex gap-2.5">
              <PortalInput
                required
                maxLength={7}
                aria-label="Team code"
                disabled={operationPending || busy}
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="C2C7ABC"
                className="flex-1 font-mono font-semibold tracking-[.1em]"
              />
              <PortalButton
                type="submit"
                size="sm"
                className="rounded-btn-sm px-4.5"
                disabled={busy || createPending || (!joinPending && code.trim().length < 7)}
              >
                {busy ? '…' : joinPending ? 'Confirm' : 'Join'}
              </PortalButton>
            </form>
          </TeamCard>
        </div>

        <PortalError message={error} />
        <p className="mt-6 text-[11.5px] text-[rgb(248_248_248/.4)]">
          joining checks eligibility, policy, capacity, and the mixed-team rule · instantly
        </p>
      </div>
    </PortalScene>
  )
}
