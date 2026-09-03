import { Composition } from "remotion";
import { Trailer } from "./Trailer.tsx";
import { Reel } from "./reel/Reel.tsx";
import { R, T } from "./theme.ts";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Trailer"
      component={Trailer}
      durationInFrames={T.total}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="Reel"
      component={Reel}
      durationInFrames={R.total}
      fps={30}
      width={1080}
      height={1920}
    />
  </>
);
