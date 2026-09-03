import { useState } from "react";
import { Flower } from "./FlowerAvatar";

export function MemberAvatarVisual({
  displayName,
  githubAvatarUrl,
  seed,
  lead,
  variant,
  flowerSize,
  flowerClassName,
}: {
  displayName: string;
  githubAvatarUrl?: string | undefined;
  seed: string;
  lead: boolean;
  variant?: number;
  flowerSize?: number;
  flowerClassName?: string;
}) {
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);
  const visibleAvatarUrl =
    githubAvatarUrl && githubAvatarUrl !== failedAvatarUrl ? githubAvatarUrl : null;

  return (
    <>
      <Flower
        seed={seed}
        lead={lead}
        {...(variant === undefined ? {} : { variant })}
        {...(flowerSize === undefined ? {} : { size: flowerSize })}
        {...(flowerClassName === undefined ? {} : { className: flowerClassName })}
      />
      {visibleAvatarUrl ? (
        <img
          src={visibleAvatarUrl}
          alt={`${displayName}'s GitHub profile photo`}
          referrerPolicy="no-referrer"
          onError={() => setFailedAvatarUrl(visibleAvatarUrl)}
          className="absolute inset-0 size-full rounded-full object-cover"
        />
      ) : null}
    </>
  );
}
