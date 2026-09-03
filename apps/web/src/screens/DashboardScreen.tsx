import {
  TeamCluster,
  type ClusterMember,
  type ClusterTeam,
} from '../components/portal/TeamCluster'
import { PortalScene } from '../components/portal/PortalScene'

const tileAreas = {
  hero: '[grid-area:hero]',
  blossom: '[grid-area:blossom]',
  rose: '[grid-area:rose]',
  center: '[grid-area:center]',
  garden: '[grid-area:garden]',
  feature: '[grid-area:feature]',
  small: '[grid-area:small]',
} as const

type TileArea = keyof typeof tileAreas

function Tile({ area }: { area: TileArea }) {
  return (
    <div
      className={`relative z-10 min-h-0 min-w-0 rounded-[18px] border border-petal-edge/70 bg-fg/5 shadow-[0_20px_44px_-30px_var(--shade-2),inset_0_1px_0_color-mix(in_srgb,var(--color-fg)_14%,transparent)] backdrop-blur-[22px] backdrop-saturate-[1.35] ${tileAreas[area]}`}
    />
  )
}

/**
 * The dashboard bento: seven glass tiles on one named-area grid. Every
 * breakpoint re-maps the areas instead of nesting grids, so the tiles reflow
 * with no wrapper elements. Phones stack two across; tablets stagger two
 * columns with the tall tiles offset; from `lg` up it is the mockup's
 * three-column composition. The grid takes the height the scene leaves it
 * (`flex-1`), so it fills the viewport without restating the scene's
 * padding, and only scrolls once the tiles would drop under their minimum.
 */
export function DashboardScreen({
  team,
  members,
  teamEditable,
  onSignOut,
}: {
  team: ClusterTeam
  members: readonly ClusterMember[]
  teamEditable: boolean
  onSignOut: () => void
}) {
  return (
    <PortalScene
      tree="both"
      branch
      onSignOut={onSignOut}
      header={
        <TeamCluster
          team={team}
          members={members}
          editable={teamEditable}
        />
      }
    >
      <div className="flex w-full max-w-[1200px] flex-1 flex-col justify-center lg:pt-8 lg:pb-6">
        <h1 className="sr-only">Dashboard</h1>
        <div
          aria-hidden="true"
          className="relative grid min-h-[720px] flex-1 grid-cols-2 grid-rows-[repeat(5,minmax(118px,1fr))] gap-4 [grid-template-areas:'hero_hero'_'blossom_rose'_'center_center'_'feature_feature'_'small_garden'] md:min-h-[640px] md:grid-rows-[1.35fr_1fr_1fr_1fr_1fr] md:[grid-template-areas:'hero_hero'_'blossom_rose'_'center_feature'_'garden_feature'_'garden_small'] lg:max-h-[880px] lg:min-h-[460px] lg:grid-cols-[322fr_365fr_395fr] lg:grid-rows-[293fr_234fr_70fr_177fr] lg:gap-[18px] lg:[grid-template-areas:'hero_hero_blossom'_'rose_center_feature'_'rose_garden_feature'_'small_garden_feature']"
        >
          <img
            src="/assets/branch-plate.png"
            alt=""
            aria-hidden
            className="pointer-events-none absolute -top-13 -left-16 z-0 w-[min(680px,70%)] max-w-none opacity-90 [filter:var(--scene-branch-filter)]"
          />
          <Tile area="hero" />
          <Tile area="blossom" />
          <Tile area="rose" />
          <Tile area="center" />
          <Tile area="garden" />
          <Tile area="feature" />
          <Tile area="small" />
        </div>
      </div>
    </PortalScene>
  )
}
