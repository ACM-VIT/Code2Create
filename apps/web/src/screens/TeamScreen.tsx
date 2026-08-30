import { api } from '@code2create/backend/api'
import { useMutation } from 'convex/react'
import { useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { PortalScene } from '../components/portal/PortalScene'
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import { PortalError, PortalInput, PortalLabel } from '../components/portal/PortalField'
import { eventSlug } from '../lib/config'
import { readableError } from '../lib/errors'
import { useOperationRunner } from '../lib/operations'

function TeamCard({
  featured = false,
  title,
  detail,
  children,
}: {
  featured?: boolean
  title: string
  detail: string
  children: ReactNode
}) {
  return (
    <div
      className={`flex w-full flex-col rounded-petal-sm px-7 py-6 text-left backdrop-blur-md sm:w-[300px] ${
        featured
          ? 'border-[1.5px] border-ring-lead bg-[image:var(--tile-bg-active)] shadow-[0_28px_56px_-20px_var(--shade-2),0_0_26px_var(--glow-rose-soft)]'
          : 'border border-petal-line bg-[image:var(--tile-bg)] shadow-[0_28px_56px_-20px_var(--shade-2)]'
      }`}
    >
      <p
        className={`mb-1.5 font-display font-light tracking-[-.01em] text-[21px] ${
          featured ? 'text-rose-light' : 'text-fg/85'
        }`}
      >
        {title}
      </p>
      <p className="mb-4.5 flex-1 text-[12.5px] leading-relaxed text-fg/60">
        {detail}
      </p>
      {children}
    </div>
  )
}

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
        <h1 className="mb-2 font-display font-normal tracking-[-.01em] text-3xl text-shadow-[0_4px_30px_var(--scene-text-glow)] lg:text-[42px]">
          Find your people.
        </h1>
        <p className="mb-8 text-[12.5px] text-fg/50">
          one team per participant · you can switch until you submit
        </p>

        <div className="flex w-full flex-col items-stretch gap-4 sm:flex-row sm:justify-center sm:gap-[18px]">
          <TeamCard
            featured
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

          <TeamCard title="Join a team" detail="paste the code your lead shared">
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
      </div>
    </PortalScene>
  )
}
