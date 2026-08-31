import type { ReactNode } from 'react'
import { AccountBadge } from '../components/portal/AccountBadge'
import { PetalCard } from '../components/portal/PetalCard'
import { Petal } from '../components/portal/Petal'
import { PortalButton, PortalTextButton } from '../components/portal/PortalButton'
import {
  PortalCheckRow,
  PortalField,
  PortalInput,
  PortalSelect,
  PortalTextarea,
} from '../components/portal/PortalField'
import { GpuSky } from '../components/portal/GpuSky'
import { Flower } from '../components/portal/FlowerAvatar'
import { PortalScene } from '../components/portal/PortalScene'
import { TreeLoader } from '../components/portal/TreeLoader'
import { SglangInterlude } from '../screens/SglangInterlude'
import { ConfirmCard } from '../screens/TeamLobbyScreen'
import { NoveltyPill } from '../screens/IntakeScreen'
import { TeamCluster, type ClusterMember, type ClusterTeam } from '../components/portal/TeamCluster'
import { TeamMenu } from '../components/portal/TeamMenu'

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

const noop = () => {}

const cluster = <TeamCluster team={team} members={members} onSignOut={noop} />
const teamMenu = <TeamMenu team={team} members={members} onSignOut={noop} />
const account = (
  <AccountBadge name="Ananya Iyer" email="ananya@vitstudent.ac.in" detail="VIT student" onSignOut={() => {}} />
)


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
        <a href="https://acmvit.in" className="absolute top-7 left-6 z-[6] opacity-85 lg:top-9 lg:left-11">
          <img src="/assets/acm-mark.svg" alt="ACM-VIT" className="size-8 lg:size-9" />
        </a>
        <div className="flex w-full max-w-[640px] flex-col items-center text-center">
          <img
            src="/assets/logo.svg"
            alt="Code2Create"
            className="mb-3.5 w-11 drop-shadow-[0_0_20px_var(--logo-glow)] lg:mb-[18px] lg:w-[52px]"
          />
          <h1 className="mb-8 flex justify-center lg:mb-10">
            <img
              src="/assets/wordmark.svg"
              alt="Code2Create"
              className="h-9 w-auto [filter:var(--wordmark-filter)] sm:h-12 lg:h-[68px]"
            />
          </h1>
          <div className="mb-7 flex w-full flex-col gap-3 sm:flex-row sm:justify-center sm:gap-4">
            <div className="w-full rounded-petal-sm border-[1.5px] border-ring-lead bg-[image:var(--tile-bg-active)] px-6 py-5 text-left shadow-[0_24px_50px_-18px_var(--shade-2),0_0_26px_var(--glow-rose-soft)] backdrop-blur-md sm:w-[250px]">
              <p className="mb-1 font-display font-light tracking-[-.01em] text-[19px] text-rose-light">VIT student</p>
              <p className="text-xs text-fg/55">on-campus, with a VIT ID card</p>
            </div>
            <div className="w-full rounded-petal-sm border border-petal-edge-soft bg-[image:var(--tile-bg)] px-6 py-5 text-left shadow-[0_24px_50px_-18px_var(--shade-2)] backdrop-blur-md sm:w-[250px]">
              <p className="mb-1 font-display font-light tracking-[-.01em] text-[19px] text-fg/85">
                external participant
              </p>
              <p className="text-xs text-fg/55">visiting from another campus</p>
            </div>
          </div>
          <PortalButton>Continue with Google</PortalButton>
        </div>
      </PortalScene>
    )],
  ['f0b', () => (
      <PortalScene tree="right" header={account}>
        <div className="flex w-full max-w-[640px] flex-col items-center">
          <h1 className="mb-7 text-center font-display font-normal tracking-[-.01em] text-3xl lg:text-[40px]">
            A few details, once.
          </h1>
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
              <PortalField label="hostel">
                {(id) => (
                  <PortalSelect id={id} defaultValue="lh_s">
                    <option value="lh_s">Ladies' hostel · S block</option>
                  </PortalSelect>
                )}
              </PortalField>
              <PortalField label="room number">
                {(id) => <PortalInput id={id} className="font-mono" defaultValue="412" />}
              </PortalField>
            </div>
            <div className="mt-4.5 border-t border-petal-line pt-4">
              <PortalCheckRow checked onChange={noop}>
                I accept the{' '}
                <span className="text-rose-light underline decoration-rose-light/50 decoration-1 underline-offset-2">
                  participant policy
                </span>{' '}
                and the{' '}
                <span className="text-rose-light underline decoration-rose-light/50 decoration-1 underline-offset-2">
                  privacy notice
                </span>
              </PortalCheckRow>
            </div>
            <div className="mt-3.5 flex items-center justify-between border-t border-petal-line pt-3.5">
              <span className="text-xs text-fg/45">saved when you continue</span>
              <PortalButton size="sm">Continue</PortalButton>
            </div>
          </PetalCard>
        </div>
      </PortalScene>
    )],
  ['f0c', () => (
      <PortalScene tree="left" header={account}>
        <div className="flex w-full max-w-[660px] flex-col items-center text-center">
          <h1 className="mb-2 font-display font-light tracking-[-.01em] text-3xl lg:text-[42px]">Find your people.</h1>
          <p className="mb-8 text-[12.5px] text-fg/50">
          </p>
          <div className="flex w-full flex-col items-stretch gap-4 sm:flex-row sm:justify-center sm:gap-[18px]">
            <div className="flex w-full flex-col rounded-petal-sm border-[1.5px] border-ring-lead bg-[image:var(--tile-bg-active)] px-7 py-6 text-left shadow-[0_28px_56px_-20px_var(--shade-2),0_0_26px_var(--glow-rose-soft)] backdrop-blur-md sm:w-[300px]">
              <p className="mb-1.5 font-display font-light tracking-[-.01em] text-[21px] text-rose-light">Create a team</p>
              <p className="mb-4.5 flex-1 text-[12.5px] leading-relaxed text-fg/60">
                you become the lead
              </p>
              <PortalButton size="sm" className="w-full">
                Start one
              </PortalButton>
            </div>
            <div className="flex w-full flex-col rounded-petal-sm border border-petal-line bg-[image:var(--tile-bg)] px-7 py-6 text-left shadow-[0_28px_56px_-20px_var(--shade-2)] backdrop-blur-md sm:w-[300px]">
              <p className="mb-1.5 font-display font-light tracking-[-.01em] text-[21px] text-fg/85">
                Join a team
              </p>
              <p className="mb-4.5 flex-1 text-[12.5px] leading-relaxed text-fg/60">
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
        </div>
      </PortalScene>
    )],
  ['f2', () => (
      <PortalScene tree="left" header={cluster} menu={teamMenu}>
        <div className="pointer-events-none absolute inset-x-0 top-[38px] z-[6] flex justify-center">
          <NoveltyPill
            state={{ status: 'ready', signal: { score: 87, band: 'distinct' } }}
            currentLength={420}
            minimumLength={80}
          />
        </div>
        <div className="flex w-full max-w-[820px] flex-col items-center lg:mb-[8vh]">
          <h1 className="mb-6 max-w-[760px] text-center font-display font-light tracking-[-.01em] text-[26px] leading-tight lg:text-[42px]">
            What do you want to build?
          </h1>
          <IdeaCard
            footer={
              <>
                <span className="font-mono text-[11px] tracking-[.04em] text-fg/45">
                  182 / 1200
                </span>
                <PortalButton size="sm">Next</PortalButton>
              </>
            }
          >
            <PortalTextarea
              rows={7}
              defaultValue="A campus lost-and-found where finders post a photo and owners describe what they lost. On-device image matching pairs the two; pickup at verified hostel desks."
              className="bare-field min-h-[180px] border-0 bg-transparent px-0 py-0 text-[17px] leading-[1.7]"
            />
          </IdeaCard>
        </div>
      </PortalScene>
    )],
  ['f3', () => (
      <PortalScene tree="left" header={cluster} menu={teamMenu}>
        <div className="flex w-full max-w-[820px] flex-col items-center lg:mb-[8vh]">
          <h1 className="mb-6 max-w-[760px] text-center font-display font-light tracking-[-.01em] text-[26px] leading-tight lg:text-[38px]">
            Who will use Foundling on day one?
          </h1>
          <div className="flex w-full flex-col">
          <button
            type="button"
            aria-label="Edit your idea"
            style={{ marginInline: 28 }}
            className="relative -mb-1.5 overflow-hidden rounded-t-petal-sm border border-b-0 border-petal-line bg-[image:var(--tile-bg)] px-5 pt-1.5 pb-3.5 text-left backdrop-blur-md transition-transform duration-250 hover:-translate-y-1"
          >
            <span className="block truncate text-[11px] text-fg/50">
              your idea <span className="text-fg/35">· A campus lost-and-found where finders post a photo and owners describe what they lost.</span>
            </span>
          </button>
          <IdeaCard
            footer={
              <>
                <span className="font-mono text-[11px] tracking-[.04em] text-fg/45">
                  148 / 600
                </span>
                <PortalButton size="sm">Next</PortalButton>
              </>
            }
          >
            <PortalTextarea
              rows={6}
              defaultValue="Hostellers first · most losses happen in messes and reading halls. Security desks join in week two once verified pickup is proven."
              className="bare-field min-h-[174px] border-0 bg-transparent px-0 py-0 text-[16.5px] leading-[1.7]"
            />
          </IdeaCard>
          </div>
        </div>
      </PortalScene>
    )],
  ['f4', () => (
      <PortalScene tree="left" header={cluster} menu={teamMenu}>
        <div className="flex w-full max-w-[820px] flex-col items-center lg:mb-[8vh]">
          <h1 className="mb-6 max-w-[760px] text-center font-display font-light tracking-[-.01em] text-[26px] leading-tight lg:text-[38px]">
            What will you build during the 48 hours?
          </h1>
          <div className="flex w-full flex-col">
          <button
            type="button"
            aria-label="Edit your idea"
            style={{ marginInline: 42 }}
            className="relative -mb-1.5 overflow-hidden rounded-t-petal-sm border border-b-0 border-petal-line bg-[image:var(--tile-bg)] px-5 pt-1.5 pb-3.5 text-left backdrop-blur-md transition-transform duration-250 hover:-translate-y-1"
          >
            <span className="block truncate text-[11px] text-fg/50">
              your idea <span className="text-fg/35">· A campus lost-and-found where finders post a photo and owners describe what they lost.</span>
            </span>
          </button>
          <button
            type="button"
            aria-expanded={false}
            style={{ marginInline: 14 }}
            className="relative -mb-1.5 overflow-hidden rounded-t-petal-sm border border-b-0 border-petal-line bg-[image:var(--tile-bg)] px-5 pt-1.5 pb-3.5 text-left backdrop-blur-md transition-transform duration-250 hover:-translate-y-1"
          >
            <span className="block truncate text-[11px] text-fg/50">Who will use Foundling on day one?</span>
          </button>
          <IdeaCard
            footer={
              <>
                <span className="text-xs text-fg/45">a sentence or two is plenty</span>
                <PortalButton size="sm" disabled>
                  Review
                </PortalButton>
              </>
            }
          >
            <PortalTextarea
              rows={6}
              placeholder="Scope the demo: which parts are live, which are mocked, what a reviewer can touch…"
              className="bare-field min-h-[174px] border-0 bg-transparent px-0 py-0 text-[16.5px] leading-[1.7]"
            />
          </IdeaCard>
          </div>
        </div>
      </PortalScene>
    )],
  ['f5', () => (
      <PortalScene tree="left" header={cluster} menu={teamMenu}>
        <div className="pointer-events-none absolute inset-x-0 top-[38px] z-[6] flex justify-center">
          <NoveltyPill state={{ status: 'ready', signal: { score: 87, band: 'distinct' } }} minimumLength={80} />
        </div>
        <div className="flex w-full max-w-[760px] flex-col items-center">
          <h1 className="mb-7 text-center font-display font-light tracking-[-.01em] text-3xl lg:text-[44px]">Paper Cranes</h1>
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
                  <span className="text-[11px] tracking-[.06em] text-fg/45">
                    {label}
                  </span>
                  <button className="flex-none text-[11.5px] text-rose-light">edit</button>
                </div>
                <div className="text-sm leading-relaxed wrap-anywhere text-fg/90">{body}</div>
              </section>
            ))}
          </PetalCard>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-5">
            <PortalButton>Continue to submit</PortalButton>
            <span className="text-xs text-fg/45">
              team and proposal changes stay open until the deadline
            </span>
          </div>
        </div>
      </PortalScene>
    )],
  ['f6', () => (
      <PortalScene tree="left" branch header={cluster} menu={teamMenu}>
        <div className="flex w-full max-w-[600px] flex-col items-center lg:mb-[8vh]">
          <h1 className="mb-6 text-center font-display font-light tracking-[-.01em] text-[26px] lg:text-[42px]">Ready to submit?</h1>
          <PetalCard className="px-8 pt-6 pb-4">
            <div className="flex items-baseline justify-between gap-4">
              <p className="m-0 min-w-0 truncate text-left text-[15.5px] font-semibold">
                Paper Cranes <span className="font-normal text-fg/55">· idea + 2 answers</span>
              </p>
              <button type="button" className="flex-none text-xs text-fg/55 transition-colors hover:text-rose-light">
                review idea
              </button>
            </div>
            <div className="mt-4 flex gap-2 border-t border-petal-line pt-4">
              {members.map((member) => {
                const lead = member.role === 'lead'
                return (
                  <div key={member.membershipId} className="flex-1 text-center">
                    <div className={`mx-auto flex size-[52px] items-center justify-center rounded-full ${lead ? 'border-2 border-ring-lead bg-avatar-lead shadow-[0_0_16px_var(--avatar-glow)]' : 'border-[1.5px] border-rose/70 bg-avatar'}`}>
                      <Flower seed={member.membershipId} lead={lead} size={26} />
                    </div>
                    <p className="mt-[7px] mb-px truncate text-xs font-semibold">{member.displayName.split(' ')[0]}</p>
                    <p className={`m-0 text-[10px] ${lead ? 'text-rose-light' : 'text-fg/50'}`}>{lead ? 'lead · you' : 'ready'}</p>
                  </div>
                )
              })}
            </div>
            <div className="mt-7">
              <PortalCheckRow checked onChange={noop}>We adhere to the Code2Create rules.</PortalCheckRow>
            </div>
            <div className="mt-4 flex items-center justify-between border-t border-petal-line pt-3.5">
              <PortalTextButton>back</PortalTextButton>
              <PortalButton size="sm" variant="solid">Submit</PortalButton>
            </div>
          </PetalCard>
        </div>
      </PortalScene>
    )],
  ['f7', () => (
      <PortalScene tree="none" header={<TeamCluster team={team} members={members} editable canManage />}>
        <div className="flex w-full max-w-[760px] flex-col items-center text-center">
          <div className="mb-5 drop-shadow-[0_0_14px_var(--glow-rose)]">
            <Petal size={34} />
          </div>
          <h1 className="mb-3.5 font-display font-light tracking-[-.01em] text-5xl leading-none lg:text-[70px]">Submitted.</h1>
          <p className="mb-8 font-ui font-normal text-base text-rose-light lg:text-[19px]">
            Paper Cranes is in the review queue
          </p>
          <div className="flex flex-wrap items-center justify-center gap-x-8 gap-y-2 text-[13px] text-fg/65">
            <span>
              status <span className="text-fg">application received</span>
            </span>
            <span aria-hidden className="hidden h-3.5 w-px bg-rose/40 sm:block" />
            <span>
              team <span className="text-rose-light">manage team</span>
            </span>
            <span aria-hidden className="hidden h-3.5 w-px bg-rose/40 sm:block" />
            <span>
              editable until <span className="text-fg">25 Sep, 6:00 pm</span>
            </span>
          </div>
          <button className="mt-8 text-[13.5px] text-rose-light underline-offset-4 hover:underline">
            edit submission
          </button>
        </div>
      </PortalScene>
    )],
  ['gate', () => (
      <PortalScene tree="both" logo="none">
        <a href="https://acmvit.in" className="absolute top-7 left-6 z-[6] opacity-85 lg:top-9 lg:left-11">
          <img src="/assets/acm-mark.svg" alt="ACM-VIT" className="size-8 [filter:var(--mark-filter)] lg:size-9" />
        </a>
        <div className="flex w-full max-w-[640px] flex-col items-center text-center">
          <img src="/assets/logo.svg" alt="" className="mb-3.5 w-11 drop-shadow-[0_0_20px_var(--logo-glow)] lg:mb-[18px] lg:w-[52px]" />
          <h1 className="mb-8 flex justify-center lg:mb-10">
            <img src="/assets/wordmark.svg" alt="Code2Create" className="h-9 w-auto [filter:var(--wordmark-filter)] sm:h-12 lg:h-[68px]" />
          </h1>
          <p className="mb-2 font-display font-light tracking-[-.01em] text-[26px] text-rose-light lg:text-[32px]">
            it’s cooking.
          </p>
          <p className="text-[13px] text-fg/50">come back in a little while</p>
        </div>
      </PortalScene>
    )],
  ['loading', () => (
      <PortalScene tree="both">
        <TreeLoader label="Loading your portal…" />
      </PortalScene>
    )],
  ['notice', () => (
      <PortalScene tree="right" header={account}>
        <div className="w-full max-w-[560px]">
          <PetalCard className="px-8 py-7">
            <h1 className="mb-3 font-display font-light tracking-[-.01em] text-2xl lg:text-3xl">
              Team access is unavailable.
            </h1>
            <p className="text-[13px] leading-relaxed text-fg/60">
              You are still on your team. You cannot create or join another team until an organizer
              restores access.
            </p>
          </PetalCard>
        </div>
      </PortalScene>
    )],
  ['f1', () => (
      <PortalScene tree="left" backdrop={<GpuSky />} header={cluster} menu={teamMenu}>
        <div className="flex w-full max-w-[1048px] flex-1 flex-col justify-center pb-40">
          <div className="max-w-[680px]">
            <h1 className="mb-8 font-display font-light tracking-[-.01em] text-balance text-5xl leading-none lg:text-7xl">One answer left.</h1>
            <PortalButton>Answer it</PortalButton>
          </div>
        </div>
        <div className="absolute inset-x-5 bottom-8 z-[3] flex flex-col gap-3 sm:flex-row sm:gap-[18px] lg:inset-x-24 lg:bottom-14">
          <div className="flex-1 rounded-petal-sm border border-rose-light/45 bg-[image:var(--tile-bg)] px-5 py-4 backdrop-blur-[10px]">
            <p className="mb-[5px] text-[10.5px] font-semibold tracking-[.08em] text-fg/50">deadline</p>
            <p className="m-0 font-display font-light tracking-[-.01em] text-[26px] text-rose-light">5 <span className="text-sm">days</span></p>
          </div>
          <div className="flex-1 rounded-petal-sm border border-rose-light/45 bg-[image:var(--tile-bg)] px-5 py-4 backdrop-blur-[10px]">
            <p className="mb-2 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">journey · 3 of 5</p>
            <div className="flex items-start pt-1">
              {(['idea', 'q1', 'q2', 'review', 'submit'] as const).map((label, index) => {
                const state = index < 2 ? 'done' : index === 2 ? 'current' : 'todo'
                return (
                  <div key={label} className="flex flex-1 flex-col items-center first:flex-none first:items-start last:flex-none last:items-end">
                    <div className="flex w-full items-center">
                      {index > 0 ? <span aria-hidden className={`h-px flex-1 ${index <= 2 ? 'bg-rose/60' : 'bg-rose/25'}`} /> : null}
                      <Petal size={15} state={state} />
                      {index < 4 ? <span aria-hidden className={`h-px flex-1 ${index < 2 ? 'bg-rose/60' : 'bg-rose/25'}`} /> : null}
                    </div>
                    <span className={`mt-1 text-[9.5px] leading-none ${state === 'current' ? 'font-semibold text-rose-light' : state === 'done' ? 'text-fg/60' : 'text-fg/35'}`}>
                      {label}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="flex-[1.4] rounded-petal-sm border border-rose-light/45 bg-[image:var(--tile-bg)] px-5 py-4 backdrop-blur-[10px]">
            <p className="mb-[5px] text-[10.5px] font-semibold tracking-[.08em] text-fg/50">editable until</p>
            <p className="m-0 font-ui text-[14.5px] text-fg">Thu, Sep 25, 6:00 PM</p>
          </div>
        </div>
      </PortalScene>
    )],
  ['fs', () => <SglangInterlude onContinue={noop} />],
  ['f7b', () => (
      <PortalScene tree="none" header={cluster} menu={teamMenu}>
        <div className="flex w-full max-w-[840px] flex-col items-center">
          <h1 className="mb-2 text-center font-display font-light tracking-[-.01em] text-3xl lg:text-[44px]">
            Paper Cranes
          </h1>
          <p className="mb-7 text-xs text-fg/50">
            editable until Aug 31, 4:00 PM · <span className="text-rose-light">back</span>
          </p>
          <div className="w-full text-left">
            <PetalCard className="px-5 py-5 sm:px-7 sm:py-6">
              <p className="whitespace-pre-line text-[15px] leading-relaxed wrap-anywhere text-fg/90">
                A campus lost-and-found where finders post a photo and owners describe what they
                lost. On-device image matching pairs the two; pickup at verified hostel desks.
              </p>
              <button type="button" className="mt-4 text-[12.5px] text-rose-light underline-offset-4 hover:underline">
                view 2 answers
              </button>
              <div className="mt-5 flex justify-end border-t border-petal-line pt-3.5">
                <button type="button" className="text-[12.5px] text-rose-light underline-offset-4 hover:underline">
                  edit submission →
                </button>
              </div>
            </PetalCard>
          </div>
        </div>
      </PortalScene>
    )],
  ['f8', () => (
      <PortalScene
        tree="none"
        header={<p className="m-0 font-ui text-[13.5px] text-rose-light">Paper Cranes · view team</p>}
        backdrop={
          <div aria-hidden className="pointer-events-none absolute inset-0 z-[2]">
            <img src="/assets/lantern-1.svg" alt="" className="absolute bottom-[-60px] left-[16%] w-[42px]" style={{ animation: 'c2crise 16s linear -2s infinite' }} />
            <img src="/assets/lantern-2.svg" alt="" className="absolute right-[19%] bottom-[-60px] w-8" style={{ animation: 'c2crise 20s linear -11s infinite' }} />
          </div>
        }
      >
        <div className="flex w-full max-w-[760px] flex-col items-center text-center">
          <p className="mb-2.5 font-ui text-xl text-rose-light">Selected for Code2Create 7.0</p>
          <h1 className="mb-[42px] font-display font-light tracking-[-.01em] text-6xl leading-[.96] text-shadow-[0_0_60px_var(--glow-rose-soft)] lg:text-[92px]">You’re in.</h1>
          <PetalCard className="flex">
            <div className="grid flex-1 grid-cols-3 px-7 py-[22px]">
              <div className="border-r border-rose/35 pr-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">venue</p>
                <p className="m-0 font-display font-light tracking-[-.01em] text-[16.5px] leading-[1.3]">Anna Auditorium, VIT Vellore</p>
              </div>
              <div className="border-r border-rose/35 px-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">when</p>
                <p className="m-0 font-display font-light tracking-[-.01em] text-[16.5px] leading-[1.3]">Oct 9, 6 PM – Oct 11, 6 PM</p>
              </div>
              <div className="pl-5">
                <p className="mb-1 text-[10.5px] font-semibold tracking-[.08em] text-fg/50">confirm by</p>
                <p className="m-0 font-display font-light tracking-[-.01em] text-[16.5px] leading-[1.3] text-rose-light">Thu, Oct 2</p>
              </div>
            </div>
            <div className="flex w-[140px] flex-none flex-col items-center justify-center gap-[7px] border-l-2 border-dashed border-rose/55">
              <div className="flex size-12 -rotate-4 items-center justify-center rounded-[10px] bg-rose text-[15px] font-bold text-wash shadow-[0_8px_20px_var(--shade-1)]">C2C</div>
              <p className="m-0 text-[11px] text-fg/60">admits four</p>
            </div>
          </PetalCard>
          <div className="mt-[42px] flex flex-col items-center gap-3.5">
            <PortalButton>Confirm your spot</PortalButton>
            <span className="text-[13.5px] text-rose-light">join the Discord →</span>
          </div>
        </div>
      </PortalScene>
    )],
  ['f10', () => (
      <PortalScene tree="right" header={<p className="m-0 font-ui text-[13.5px] text-rose-light/80">4 of 4 seats</p>}>
        <div className="flex w-full max-w-[860px] flex-col items-center text-center">
          <h1 className="mb-11 font-display font-light tracking-[-.01em] text-4xl lg:text-[54px]">Paper Cranes</h1>
          <div className="mb-10 flex flex-wrap items-start justify-center gap-[34px]">
            {members.map((member) => {
              const lead = member.role === 'lead'
              return (
                <div key={member.teamMemberId} className="w-[120px]">
                  <div className={`relative mx-auto flex size-[88px] items-center justify-center rounded-full text-2xl font-semibold ${lead ? 'border-[2.5px] border-ring-lead bg-avatar-lead shadow-[0_0_26px_var(--avatar-glow)]' : 'border-2 border-rose/70 bg-avatar'}`}>
                    <Flower seed={member.membershipId} lead={lead} size={38} />
                    {lead ? <span className="absolute -top-1.5 -right-1"><Petal size={20} /></span> : null}
                  </div>
                  <p className="mt-3 mb-0.5 text-sm font-semibold">{member.displayName.split(' ')[0]}</p>
                  <p className={`m-0 text-[11.5px] ${lead ? 'text-rose-light' : 'text-fg/50'}`}>{lead ? 'lead · you' : 'ready'}</p>
                </div>
              )
            })}
          </div>
          <div className="flex items-center gap-3 rounded-petal-sm border border-petal-edge bg-[image:var(--tile-bg-active)] px-5 py-3 backdrop-blur-md lg:gap-3.5 lg:px-6">
            <span className="whitespace-nowrap font-mono text-[17px] tracking-[.14em] text-rose-light lg:text-[19px]">C2C-PCRN</span>
            <span aria-hidden className="h-[18px] w-px bg-rose/40" />
            <span className="text-[13px]">copy</span>
            <span className="whitespace-nowrap text-[13px]">share link</span>
          </div>
          <div className="mt-7 flex flex-wrap items-baseline justify-center gap-x-3.5 gap-y-1 text-[13.5px] text-fg/45">
            <span className="text-fg/65">change leader</span>
            <span aria-hidden className="text-fg/30">·</span>
            <span className="text-fg/65">remove a member</span>
            <span aria-hidden className="text-fg/30">·</span>
            <span className="text-fg/65">leave team</span>
            <span aria-hidden className="text-fg/30">·</span>
            <span>changes close Aug 31, 4:00 PM</span>
            <span aria-hidden className="text-fg/30">·</span>
            <span className="text-rose-light">back home</span>
          </div>
        </div>
      </PortalScene>
    )],
  ['f10b', () => (
      <PortalScene tree="right" header={<p className="m-0 font-ui text-[13.5px] text-rose-light/80">4 of 4 seats</p>}>
        <div className="flex w-full max-w-[860px] flex-col items-center text-center">
          <h1 className="mb-11 font-display font-light tracking-[-.01em] text-4xl lg:text-[54px]">Paper Cranes</h1>
          <div className="mb-10 flex flex-wrap items-start justify-center gap-[34px]">
            {members.map((member, index) => {
              const lead = member.role === 'lead'
              const target = index >= 2
              return (
                <div key={member.teamMemberId} className={`w-[120px] ${target ? '' : 'opacity-40 saturate-[.65]'}`}>
                  <div className={`group relative mx-auto flex size-[88px] items-center justify-center rounded-full text-2xl font-semibold ${lead ? 'border-[2.5px] border-ring-lead bg-avatar-lead shadow-[0_0_26px_var(--avatar-glow)]' : 'border-2 border-rose/70 bg-avatar'} ${target ? 'cursor-pointer transition-all duration-250 hover:-translate-y-1 hover:border-rose-light' : ''}`}>
                    <Flower seed={member.membershipId} lead={lead} size={38} />
                    {lead ? <span className="absolute -top-1.5 -right-1"><Petal size={20} /></span> : null}
                    {target ? (
                      <span className="absolute -top-1 -right-1 flex size-[22px] items-center justify-center rounded-full border border-rose/70 bg-wash text-rose-light shadow-[0_4px_12px_var(--shade-1)] transition-all duration-250 group-hover:border-rose-light group-hover:bg-rose group-hover:text-wash">
                        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
                          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                        </svg>
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-3 mb-0.5 text-sm font-semibold">{member.displayName.split(' ')[0]}</p>
                  <p className={`m-0 text-[11.5px] ${lead || index === 1 ? 'text-rose-light' : 'text-fg/50'}`}>{lead ? 'lead' : index === 1 ? 'you' : 'ready'}</p>
                </div>
              )
            })}
          </div>
          <ConfirmCard
            question="Remove Sara from the team?"
            detail="Their access ends and the join code changes."
            primaryLabel="Remove them"
            onPrimary={() => {}}
            secondaryLabel="back"
            onSecondary={() => {}}
            busy={false}
          />
        </div>
      </PortalScene>
    )],
  ['f12', () => (
      <PortalScene tree="left">
        <div className="flex w-full max-w-[480px] flex-col items-center">
          <p className="mb-6 font-ui text-lg text-rose-light">more</p>
          <PetalCard className="px-6 py-1.5">
            {[
              ['Profile', 'Ananya Iyer · 23BCE1847'],
              ['Notifications', 'email · delivered'],
              ['Integrations', 'repos + Figma'],
              ['Discord', 'joined'],
              ['Support', ''],
              ['Event policy', 'Participant policy · 7.0'],
              ['Privacy', ''],
            ].map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-4 border-b border-petal-line py-[15px]">
                <span className="text-sm">{label}</span>
                <span className="text-xs text-fg/50">{value}</span>
              </div>
            ))}
            <div className="flex items-center justify-between py-[15px]">
              <span className="text-sm text-rose-light">Sign out</span>
            </div>
          </PetalCard>
        </div>
      </PortalScene>
    )],
  ] as const),
)

/** Renders one gallery screen's fixture content. */
export function ScreenFixture({ id }: { id: string }) {
  const render = screens[id]
  return render ? <>{render()}</> : null
}
