import type { ReactNode } from 'react'
import { AccountBadge } from '../components/portal/AccountBadge'
import { PetalCard } from '../components/portal/PetalCard'
import { Petal, SakuraSteps } from '../components/portal/Petal'
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import {
  PortalCheckRow,
  PortalField,
  PortalInput,
  PortalSelect,
  PortalTextarea,
} from '../components/portal/PortalField'
import { PortalScene } from '../components/portal/PortalScene'
import { TeamCluster, type ClusterMember, type ClusterTeam } from '../components/portal/TeamCluster'

// Fixture content for the dev screen gallery. These compose the same portal
// primitives the real screens use, so the design system is genuinely shared —
// but the copy and data are stand-ins, not live queries.

const team: ClusterTeam = {
  name: 'Paper Cranes',
  publicCode: 'C2C-PCRN',
  activeMemberCount: 4,
  teamMaximumSize: 4,
  currentMembershipId: 'm2',
}

const members: ClusterMember[] = [
  { teamMemberId: '1', membershipId: 'm1', role: 'lead', displayName: 'Ananya Iyer' },
  { teamMemberId: '2', membershipId: 'm2', role: 'member', displayName: 'Rohan Mehta' },
  { teamMemberId: '3', membershipId: 'm3', role: 'member', displayName: 'Sara Thomas' },
  { teamMemberId: '4', membershipId: 'm4', role: 'member', displayName: 'Dev Patel' },
]

const cluster = (
  <TeamCluster
    team={team}
    members={members}
    leaveAction={{
      available: true,
      pending: false,
      retrying: false,
      error: null,
      onConfirm: async () => undefined,
    }}
  />
)
const account = (
  <AccountBadge name="Ananya Iyer" email="ananya@vitstudent.ac.in" detail="VIT student" />
)

const noop = () => {}

function IdeaCard({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <PetalCard className="px-6 pt-[26px] pb-[18px] lg:px-[30px]">
      {children}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-petal-line pt-3.5">
        {footer}
      </div>
    </PetalCard>
  )
}

const screens: Record<string, () => ReactNode> = Object.fromEntries(
  ([
  ['f0a', () => (
      <PortalScene tree="both" logo="none">
        <div className="flex w-full max-w-[640px] flex-col items-center text-center">
          <img
            src="/assets/logo.svg"
            alt="Code2Create"
            className="mb-3.5 w-11 drop-shadow-[0_0_20px_rgba(216,132,162,.55)] lg:mb-[18px] lg:w-[52px]"
          />
          <p className="mb-2 font-display text-[15px] italic text-rose-light lg:text-[19px]">
            welcome to
          </p>
          <h1 className="mb-8 font-display text-[40px] leading-none text-shadow-[0_8px_50px_rgba(0,0,0,.6)] lg:mb-10 lg:text-[76px]">
            Code2Create <span className="italic text-rose-light">7.0</span>
          </h1>
          <div className="mb-7 flex w-full flex-col gap-3 sm:flex-row sm:justify-center sm:gap-4">
            <div className="w-full rounded-petal-sm border-[1.5px] border-rose-light bg-[linear-gradient(155deg,rgba(255,255,255,.1),rgba(12,0,4,.55)_60%)] px-6 py-5 text-left shadow-[0_24px_50px_-18px_rgba(0,0,0,.8),0_0_26px_rgba(216,132,162,.25)] backdrop-blur-md sm:w-[250px]">
              <p className="mb-1 font-display text-[19px] text-rose-light">VIT student</p>
              <p className="text-xs text-[rgb(248_248_248/.55)]">on-campus, with a VIT ID card</p>
            </div>
            <div className="w-full rounded-petal-sm border border-petal-edge-soft bg-[linear-gradient(155deg,rgba(255,255,255,.06),rgba(12,0,4,.48)_60%)] px-6 py-5 text-left shadow-[0_24px_50px_-18px_rgba(0,0,0,.8)] backdrop-blur-md sm:w-[250px]">
              <p className="mb-1 font-display text-[19px] text-[rgb(248_248_248/.85)]">
                external participant
              </p>
              <p className="text-xs text-[rgb(248_248_248/.55)]">visiting from another campus</p>
            </div>
          </div>
          <PortalButton>Continue with Google</PortalButton>
          <p className="mt-4 text-[11.5px] text-[rgb(248_248_248/.4)]">
            the server verifies your account class · nothing else to type yet
          </p>
        </div>
      </PortalScene>
    )],
  ['f0b', () => (
      <PortalScene tree="right" header={account}>
        <div className="flex w-full max-w-[640px] flex-col items-center">
          <h1 className="mb-2 text-center font-display text-3xl italic lg:text-[40px]">
            A few details, once.
          </h1>
          <p className="mb-7 text-[12.5px] text-[rgb(248_248_248/.5)]">
            only what Google can’t tell us
          </p>
          <PetalCard className="px-6 pt-[26px] pb-[18px] lg:px-[30px]">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3.5 sm:grid-cols-2">
              <PortalField label="full name">
                {(id) => <PortalInput id={id} defaultValue="Ananya Iyer" />}
              </PortalField>
              <PortalField label="preferred name" hint="optional">
                {(id) => <PortalInput id={id} placeholder="what should we call you?" />}
              </PortalField>
              <PortalField label="registration number">
                {(id) => <PortalInput id={id} className="font-mono" defaultValue="23BCE1847" />}
              </PortalField>
              <PortalField label="year of study">
                {(id) => (
                  <PortalSelect id={id} defaultValue="third">
                    <option value="third">Third year</option>
                  </PortalSelect>
                )}
              </PortalField>
              <PortalField label="programme">
                {(id) => <PortalInput id={id} defaultValue="B.Tech CSE" />}
              </PortalField>
              <PortalField label="campus">
                {(id) => <PortalInput id={id} defaultValue="Vellore" />}
              </PortalField>
            </div>
            <div className="mt-4.5 border-t border-petal-line pt-4">
              <PortalCheckRow checked onChange={noop}>
                I accept the participant policy and the{' '}
                <span className="text-rose-light">privacy notice</span> · proposal text may be
                compared for novelty; keep personal data out of it.
              </PortalCheckRow>
            </div>
            <div className="mt-3.5 flex items-center justify-between border-t border-petal-line pt-3.5">
              <span className="text-xs text-[rgb(248_248_248/.45)]">saved when you continue</span>
              <PortalButton size="sm">Continue</PortalButton>
            </div>
          </PetalCard>
        </div>
      </PortalScene>
    )],
  ['f0c', () => (
      <PortalScene tree="left" header={account}>
        <div className="flex w-full max-w-[660px] flex-col items-center text-center">
          <h1 className="mb-2 font-display text-3xl italic lg:text-[42px]">Find your people.</h1>
          <p className="mb-8 text-[12.5px] text-[rgb(248_248_248/.5)]">
            one team per participant · you can switch until you submit
          </p>
          <div className="flex w-full flex-col items-stretch gap-4 sm:flex-row sm:justify-center sm:gap-[18px]">
            <div className="flex w-full flex-col rounded-petal-sm border-[1.5px] border-rose-light bg-[linear-gradient(155deg,rgba(255,255,255,.1),rgba(12,0,4,.55)_60%)] px-7 py-6 text-left shadow-[0_28px_56px_-20px_rgba(0,0,0,.85),0_0_26px_rgba(216,132,162,.25)] backdrop-blur-md sm:w-[300px]">
              <div className="mb-3">
                <Petal size={26} />
              </div>
              <p className="mb-1.5 font-display text-[21px] text-rose-light">Create a team</p>
              <p className="mb-4.5 flex-1 text-[12.5px] leading-relaxed text-[rgb(248_248_248/.6)]">
                you become the lead · you get a code and a link to share
              </p>
              <PortalButton size="sm" className="w-full">
                Start one
              </PortalButton>
            </div>
            <div className="flex w-full flex-col rounded-petal-sm border border-petal-edge-soft bg-[linear-gradient(155deg,rgba(255,255,255,.06),rgba(12,0,4,.48)_60%)] px-7 py-6 text-left shadow-[0_28px_56px_-20px_rgba(0,0,0,.85)] backdrop-blur-md sm:w-[300px]">
              <div className="mb-3">
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
              </div>
              <p className="mb-1.5 font-display text-[21px] text-[rgb(248_248_248/.85)]">
                Join a team
              </p>
              <p className="mb-4.5 flex-1 text-[12.5px] leading-relaxed text-[rgb(248_248_248/.6)]">
                paste the code your lead shared
              </p>
              <div className="flex gap-2.5">
                <PortalInput
                  placeholder="C2C7ABC"
                  aria-label="Team code"
                  className="flex-1 font-mono font-semibold tracking-[.1em]"
                />
                <PortalButton size="sm" className="rounded-btn-sm px-4.5">
                  Join
                </PortalButton>
              </div>
            </div>
          </div>
          <p className="mt-6 text-[11.5px] text-[rgb(248_248_248/.4)]">
            joining checks eligibility, policy, capacity, and the mixed-team rule · instantly
          </p>
        </div>
      </PortalScene>
    )],
  ['f2', () => (
      <PortalScene tree="left" header={cluster}>
        <div className="pointer-events-none absolute inset-x-0 top-[38px] z-[6] flex justify-center">
          <p className="inline-flex items-center gap-1.5 rounded-full border border-[rgb(254_180_203/.45)] bg-[rgb(12_0_4/.55)] px-3.5 py-1.5 text-[11.5px] text-rose-light backdrop-blur-md">
            <Petal size={10} />
            87% distinct
          </p>
        </div>
        <div className="flex w-full max-w-[820px] flex-col items-center">
          <div className="mb-4.5">
            <SakuraSteps total={3} current={0} />
          </div>
          <h1 className="mb-6 max-w-[760px] text-center font-display text-[26px] leading-tight italic lg:text-[42px]">
            What do you want to build?
          </h1>
          <IdeaCard
            footer={
              <>
                <span className="text-xs text-[rgb(248_248_248/.45)]">
                  182 / 1200 · do not include private contact details
                </span>
                <PortalButton size="sm">Next</PortalButton>
              </>
            }
          >
            <PortalTextarea
              rows={7}
              defaultValue="A campus lost-and-found where finders post a photo and owners describe what they lost. On-device image matching pairs the two; pickup at verified hostel desks."
              className="min-h-[180px] border-0 bg-transparent px-0 py-0 text-[17px] leading-[1.7]"
            />
          </IdeaCard>
        </div>
      </PortalScene>
    )],
  ['f3', () => (
      <PortalScene tree="left" header={cluster}>
        <div className="flex w-full max-w-[820px] flex-col items-center">
          <div className="mb-4.5">
            <SakuraSteps total={3} current={1} />
          </div>
          <p className="mb-2.5 text-[10.5px] font-semibold tracking-[.14em] text-[rgb(248_248_248/.45)] uppercase">
            asked because of your idea
          </p>
          <h1 className="mb-6 max-w-[760px] text-center font-display text-[26px] leading-tight italic lg:text-[38px]">
            Who will use Foundling on day one?
          </h1>
          <IdeaCard
            footer={
              <>
                <span className="text-xs text-[rgb(248_248_248/.45)]">
                  148 / 600 · a sentence or two is plenty
                </span>
                <div className="flex items-center gap-4.5">
                  <PortalTextButton>edit idea</PortalTextButton>
                  <PortalTextButton>skip</PortalTextButton>
                  <PortalButton size="sm">Next</PortalButton>
                </div>
              </>
            }
          >
            <PortalTextarea
              rows={6}
              defaultValue="Hostellers first · most losses happen in messes and reading halls. Security desks join in week two once verified pickup is proven."
              className="min-h-[174px] border-0 bg-transparent px-0 py-0 text-[16.5px] leading-[1.7]"
            />
          </IdeaCard>
        </div>
      </PortalScene>
    )],
  ['f4', () => (
      <PortalScene tree="left" header={cluster}>
        <div className="flex w-full max-w-[820px] flex-col items-center">
          <div className="mb-4.5">
            <SakuraSteps total={3} current={2} />
          </div>
          <p className="mb-2.5 text-[10.5px] font-semibold tracking-[.14em] text-[rgb(248_248_248/.45)] uppercase">
            last one · then review
          </p>
          <h1 className="mb-6 max-w-[760px] text-center font-display text-[26px] leading-tight italic lg:text-[38px]">
            What will you build during the 48 hours?
          </h1>
          <IdeaCard
            footer={
              <>
                <span className="text-xs text-[rgb(248_248_248/.45)]">
                  0 / 600 · a sentence or two is plenty
                </span>
                <div className="flex items-center gap-4.5">
                  <PortalTextButton>edit idea</PortalTextButton>
                  <PortalTextButton>skip</PortalTextButton>
                  <PortalButton size="sm" disabled>
                    Review
                  </PortalButton>
                </div>
              </>
            }
          >
            <PortalTextarea
              rows={6}
              placeholder="Scope the demo: which parts are live, which are mocked, what a reviewer can touch…"
              className="min-h-[174px] border-0 bg-transparent px-0 py-0 text-[16.5px] leading-[1.7]"
            />
          </IdeaCard>
          <p className="mt-5 text-[11.5px] text-[rgb(248_248_248/.4)]">
            the Next button wakes up when you write something
          </p>
        </div>
      </PortalScene>
    )],
  ['f5', () => (
      <PortalScene tree="left" header={cluster}>
        <div className="flex w-full max-w-[760px] flex-col items-center">
          <p className="mb-1.5 font-display text-[17px] italic text-rose-light">
            your proposal, together
          </p>
          <h1 className="mb-7 text-center font-display text-3xl lg:text-[44px]">Paper Cranes</h1>
          <PetalCard className="px-8 py-6">
            {[
              [
                'the idea',
                'A campus lost-and-found where finders post a photo and owners describe what they lost. On-device image matching pairs the two; pickup at verified hostel desks.',
              ],
              [
                'who will use Foundling on day one?',
                'Hostellers first · most losses happen in messes and reading halls.',
              ],
              [
                'what will you build during the 48 hours?',
                'Live photo-match pipeline and posting flow; desk verification mocked.',
              ],
            ].map(([label, body]) => (
              <section
                key={label}
                className="border-b border-petal-line py-4 first:pt-0 last:border-b-0 last:pb-0"
              >
                <div className="mb-1.5 flex items-baseline justify-between gap-4">
                  <span className="text-[11px] tracking-[.06em] text-[rgb(248_248_248/.45)]">
                    {label}
                  </span>
                  <button className="flex-none text-[11.5px] text-rose-light">edit</button>
                </div>
                <div className="text-sm leading-relaxed text-[rgb(248_248_248/.9)]">{body}</div>
              </section>
            ))}
          </PetalCard>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-5">
            <PortalButton>Continue to submit</PortalButton>
            <span className="text-xs text-[rgb(248_248_248/.45)]">
              the next screen locks the team, not the writing
            </span>
          </div>
        </div>
      </PortalScene>
    )],
  ['f6', () => (
      <PortalScene tree="left" branch header={cluster}>
        <div className="flex w-full max-w-[600px] flex-col items-center">
          <div className="mb-4.5">
            <SakuraSteps total={3} current={3} />
          </div>
          <h1 className="mb-6 text-center font-display text-[26px] italic lg:text-[42px]">
            Ready to submit?
          </h1>
          <PetalCard className="px-8 pt-7 pb-4">
            <div className="mb-3.5 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="mb-1 truncate text-[15.5px] font-semibold">Paper Cranes</p>
                <p className="text-xs text-[rgb(248_248_248/.5)]">
                  proposal + 2 answers · <span className="text-rose-light">review</span>
                </p>
              </div>
              <div className="flex flex-none">
                {members.map((member, index) => (
                  <div
                    key={member.membershipId}
                    className={`flex size-8 items-center justify-center rounded-full text-[10.5px] font-semibold ${
                      member.role === 'lead'
                        ? 'border-[1.5px] border-rose-light bg-avatar-lead'
                        : 'border-[1.5px] border-[rgb(216_132_162/.7)] bg-avatar'
                    } ${index > 0 ? '-ml-2' : ''}`}
                  >
                    {member.displayName
                      .split(' ')
                      .map((part) => part[0])
                      .join('')}
                  </div>
                ))}
              </div>
            </div>
            <p className="mb-4 border-t border-petal-line pt-4 font-display text-[17px] leading-normal italic text-rose-light">
              Submitting locks your team of four. The writing stays editable until the deadline.
            </p>
            <div className="flex flex-col gap-3">
              <PortalCheckRow checked onChange={noop}>
                We will begin project-specific implementation and design after the official start.
              </PortalCheckRow>
              <PortalCheckRow checked={false} onChange={noop}>
                I understand submitting locks the team.
              </PortalCheckRow>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-petal-line pt-3.5">
              <PortalTextButton>back</PortalTextButton>
              <PortalButton size="sm" disabled>
                Submit proposal
              </PortalButton>
            </div>
          </PetalCard>
        </div>
      </PortalScene>
    )],
  ['f7', () => (
      <PortalScene tree="none" header={<TeamCluster team={team} members={members} locked />}>
        <div className="flex w-full max-w-[760px] flex-col items-center text-center">
          <div className="mb-5 drop-shadow-[0_0_14px_rgba(254,180,203,.5)]">
            <Petal size={34} />
          </div>
          <h1 className="mb-3.5 font-display text-5xl leading-none lg:text-[70px]">Submitted.</h1>
          <p className="mb-8 font-display text-base italic text-rose-light lg:text-[19px]">
            Paper Cranes is in the review queue
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-[13px] text-[rgb(248_248_248/.65)]">
            <span>
              status <span className="text-paper">application received</span>
            </span>
            <span aria-hidden className="hidden h-3.5 w-px bg-[rgb(216_132_162/.4)] sm:block" />
            <span>
              team <span className="text-rose-light">locked</span>
            </span>
            <span aria-hidden className="hidden h-3.5 w-px bg-[rgb(216_132_162/.4)] sm:block" />
            <span>
              editable until <span className="text-paper">25 Sep, 6:00 pm</span>
            </span>
          </div>
          <button className="mt-8 text-[13.5px] text-rose-light underline-offset-4 hover:underline">
            edit proposal
          </button>
        </div>
      </PortalScene>
    )],
  ['loading', () => (
      <PortalScene tree="both">
        <p role="status" className="font-display text-xl italic text-rose-light">
          Loading your portal…
        </p>
      </PortalScene>
    )],
  ['notice', () => (
      <PortalScene tree="right" header={account}>
        <PetalCard className="max-w-[560px] px-8 py-7">
          <h1 className="mb-3 font-display text-2xl italic lg:text-3xl">
            Team access is unavailable.
          </h1>
          <p className="text-[13px] leading-relaxed text-[rgb(248_248_248/.6)]">
            You are still on your team. You cannot create or join another team until an organizer
            restores access.
          </p>
        </PetalCard>
      </PortalScene>
    )],
  ] as const),
)

/** Renders one gallery screen's fixture content. */
export function ScreenFixture({ id }: { id: string }) {
  const render = screens[id]
  return render ? <>{render()}</> : null
}
