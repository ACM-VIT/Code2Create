import { Flower } from './FlowerAvatar'

export function MemberAvatarVisual({
  displayName,
  githubAvatarUrl,
  seed,
  lead,
  variant,
  flowerSize,
  flowerClassName,
}: {
  displayName: string
  githubAvatarUrl?: string | undefined
  seed: string
  lead: boolean
  variant?: number
  flowerSize?: number
  flowerClassName?: string
}) {
  return (
    <>
      <Flower
        seed={seed}
        lead={lead}
        {...(variant === undefined ? {} : { variant })}
        {...(flowerSize === undefined ? {} : { size: flowerSize })}
        {...(flowerClassName === undefined ? {} : { className: flowerClassName })}
      />
      {githubAvatarUrl ? (
        <img
          src={githubAvatarUrl}
          alt={`${displayName}'s GitHub profile photo`}
          referrerPolicy="no-referrer"
          onError={(event) => event.currentTarget.remove()}
          className="absolute inset-0 size-full rounded-full object-cover"
        />
      ) : null}
    </>
  )
}
