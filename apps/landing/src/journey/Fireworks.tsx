import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import gsap from "gsap";

/*
 * The sponsor volley is a scroll animation. No firework physics continues
 * after the wheel stops: each rocket, crack, and letter position is derived
 * from the progress supplied by Journey. The same prepared stars draw the
 * radial crack and then travel into the sponsor name. This component owns the
 * whole sponsor cue sequence so rendering and timing cannot drift apart.
 */

export interface FireworksHandle {
  setTimeline(masterTime: number): void;
}

type Color = readonly [number, number, number];

type SponsorTier = "lead" | "featured" | "supporting";

interface SponsorSpec {
  name: string;
  logo: string;
  logoClass: string;
  href: string;
  tier: SponsorTier;
  cue: number;
  duration: number;
  x: number;
  y: number;
  logoY: number;
  from: number;
  core: Color;
  ember: Color;
  phone: { x: number; y: number; logoY: number; from: number };
}

const SPONSORS: readonly SponsorSpec[] = [
  {
    name: "SGLang",
    logo: "/assets/sponsors/sglang.png",
    logoClass: "sponsor__logo--sglang",
    href: "https://sglang.io/",
    tier: "lead",
    cue: 104,
    duration: 10,
    x: 24,
    y: 29,
    logoY: 14,
    from: 35,
    core: [236, 186, 255],
    ember: [176, 112, 250],
    phone: { x: 50, y: 23, logoY: 14, from: 20 },
  },
  {
    name: "ElevenLabs",
    logo: "/assets/sponsors/elevenlabs.svg",
    logoClass: "sponsor__logo--elevenlabs",
    href: "https://elevenlabs.io/",
    tier: "featured",
    cue: 114,
    duration: 8,
    x: 76,
    y: 31,
    logoY: 29,
    from: 85,
    core: [255, 255, 255],
    ember: [148, 196, 255],
    phone: { x: 50, y: 40, logoY: 40, from: 82 },
  },
  {
    name: "Tin Computer",
    logo: "/assets/sponsors/tin-computer.png",
    logoClass: "sponsor__logo--tin",
    href: "https://tin.computer/",
    tier: "supporting",
    cue: 122,
    duration: 3.6,
    x: 10,
    y: 64,
    logoY: 58,
    from: 15,
    core: [255, 236, 198],
    ember: [255, 166, 89],
    phone: { x: 18, y: 58, logoY: 53, from: 10 },
  },
  {
    name: "ProtoFlow",
    logo: "/assets/sponsors/protoflow.png",
    logoClass: "sponsor__logo--protoflow",
    href: "https://www.protoflow.ai/",
    tier: "supporting",
    cue: 122,
    duration: 3.6,
    x: 30,
    y: 64,
    logoY: 58,
    from: 36,
    core: [205, 239, 255],
    ember: [92, 186, 255],
    phone: { x: 50, y: 58, logoY: 53, from: 43 },
  },
  {
    name: "CodeCrafters",
    logo: "/assets/sponsors/codecrafters.svg",
    logoClass: "sponsor__logo--codecrafters",
    href: "https://codecrafters.io/",
    tier: "supporting",
    cue: 122,
    duration: 3.6,
    x: 50,
    y: 64,
    logoY: 58,
    from: 56,
    core: [239, 232, 255],
    ember: [188, 144, 255],
    phone: { x: 82, y: 58, logoY: 53, from: 90 },
  },
  {
    name: "n8n",
    logo: "/assets/sponsors/n8n.svg",
    logoClass: "sponsor__logo--n8n",
    href: "https://n8n.io/",
    tier: "supporting",
    cue: 122,
    duration: 3.6,
    x: 70,
    y: 64,
    logoY: 58,
    from: 64,
    core: [255, 190, 207],
    ember: [234, 75, 113],
    phone: { x: 30, y: 73, logoY: 69, from: 22 },
  },
  {
    name: "DevSwarm",
    logo: "/assets/sponsors/devswarm.png",
    logoClass: "sponsor__logo--devswarm",
    href: "https://devswarm.ai/",
    tier: "supporting",
    cue: 122,
    duration: 3.6,
    x: 90,
    y: 64,
    logoY: 58,
    from: 85,
    core: [225, 216, 255],
    ember: [105, 74, 255],
    phone: { x: 70, y: 73, logoY: 69, from: 78 },
  },
];

const SPONSORS_END = 142;
const SPONSORS_FALL_END = 150;

interface FireworkDimensions {
  burstScale: number;
  starScale: number;
  targetWidth: number;
  targetHeight: number;
  textOffset: number;
}

interface FireworkTierSpec {
  budget: number;
  desktop: FireworkDimensions;
  phone: FireworkDimensions;
}

const FIREWORK_TIERS: Record<SponsorTier, FireworkTierSpec> = {
  lead: {
    budget: 800,
    desktop: {
      burstScale: 1.28,
      starScale: 1.12,
      targetWidth: 0.35,
      targetHeight: 0.1,
      textOffset: 0.13,
    },
    phone: {
      burstScale: 1,
      starScale: 1.08,
      targetWidth: 0.76,
      targetHeight: 0.075,
      textOffset: 0.095,
    },
  },
  featured: {
    budget: 740,
    desktop: {
      burstScale: 1.08,
      starScale: 1,
      targetWidth: 0.31,
      targetHeight: 0.085,
      textOffset: 0.11,
    },
    phone: {
      burstScale: 0.84,
      starScale: 0.96,
      targetWidth: 0.68,
      targetHeight: 0.065,
      textOffset: 0.09,
    },
  },
  supporting: {
    budget: 680,
    desktop: {
      burstScale: 0.62,
      starScale: 0.58,
      targetWidth: 0.17,
      targetHeight: 0.045,
      textOffset: 0.1,
    },
    phone: {
      burstScale: 0.48,
      starScale: 0.54,
      targetWidth: 0.26,
      targetHeight: 0.034,
      textOffset: 0.065,
    },
  },
};

const TAU = Math.PI * 2;
const LAUNCH_END = 0.34;
const BURST_END = 0.6;
const FORM_END = 0.82;
const TWINKLE_GROUPS = 4;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const easeOutCubic = (value: number) => 1 - (1 - value) ** 3;
const smoothstep = (value: number) => value * value * (3 - 2 * value);
const gravityOffset = (height: number, progress: number) => {
  const fall = smoothstep(clamp01(progress));
  return height * (0.12 * fall + 0.78 * fall * fall);
};
const channels = (color: Color) => `${color[0]}, ${color[1]}, ${color[2]}`;

const sponsorAt = (index: number, phone: boolean) =>
  phone ? { ...SPONSORS[index], ...SPONSORS[index].phone } : SPONSORS[index];

interface TextPoint {
  x: number;
  y: number;
}

interface TextSample {
  points: TextPoint[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface PreparedStar {
  angle: number;
  radius: number;
  targetX: number;
  targetY: number;
  size: number;
  arc: number;
  twinkleGroup: number;
  fallDelay: number;
  fallSpeed: number;
}

interface PreparedSponsor {
  burstX: number;
  burstY: number;
  burstScale: number;
  mortarX: number;
  mortarY: number;
  stars: PreparedStar[];
}

interface DrawPoint {
  x: number;
  y: number;
}

interface StepCanvas extends HTMLCanvasElement {
  __peek?: () => {
    progresses: number[];
    stars: number;
    letters: number;
    budgets: number[];
    burstRadii: number[];
    fallProgress: number;
  };
}

const sampleText = (name: string): TextSample => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("The browser could not create the firework text sampler.");

  const font = "700 72px Arial, sans-serif";
  context.font = font;
  canvas.width = Math.ceil(context.measureText(name).width + 32);
  canvas.height = 112;
  context.font = font;
  context.fillStyle = "#fff";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(name, canvas.width / 2, canvas.height / 2);

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const points: TextPoint[] = [];
  let minX = canvas.width;
  let maxX = 0;
  let minY = canvas.height;
  let maxY = 0;

  for (let y = 0; y < canvas.height; y += 2) {
    for (let x = 0; x < canvas.width; x += 2) {
      if (pixels[(y * canvas.width + x) * 4 + 3] <= 150) continue;
      points.push({ x, y });
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  if (points.length === 0) {
    throw new Error(`The firework text sampler returned no points for ${name}.`);
  }
  return { points, minX, maxX, minY, maxY };
};

const pickEvenly = (points: readonly TextPoint[], count: number) => {
  if (points.length <= count) return points;
  const selected: TextPoint[] = [];
  const stride = points.length / count;
  for (let index = 0; index < count; index += 1) {
    selected.push(points[Math.floor((index + 0.5) * stride)]);
  }
  return selected;
};

/* A stable pseudo-random sequence keeps the firework geometry fixed while the
   scroll moves backward and forward. Rebuilding at a breakpoint changes only
   scale and placement, never the shape of the crack. */
const randomSequence = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

const Fireworks = forwardRef<FireworksHandle, Record<never, never>>(
  function Fireworks(_props, ref) {
    const canvasRef = useRef<StepCanvas>(null);
    const logoRefs = useRef<(HTMLAnchorElement | null)[]>([]);
    const progresses = useRef(SPONSORS.map(() => 0));
    const twinklePhases = useRef(SPONSORS.map(() => 0));
    const fallProgress = useRef(0);
    const canvasHeight = useRef(0);
    const renderer = useRef<{ request(): void } | null>(null);

    const [narrow, setNarrow] = useState(
      () => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches,
    );

    useEffect(() => {
      const query = window.matchMedia("(max-width: 760px)");
      const sync = () => setNarrow(query.matches);
      sync();
      query.addEventListener("change", sync);
      return () => query.removeEventListener("change", sync);
    }, []);

    const setLogoProgress = (index: number, progress: number, falling: number) => {
      const logo = logoRefs.current[index];
      if (!logo) return;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const revealFrom = reduced ? 0.08 : FORM_END - 0.04;
      const revealDuration = reduced ? 0.12 : 0.14;
      const reveal = smoothstep(clamp01((progress - revealFrom) / revealDuration));
      const exitFade = 1 - smoothstep(clamp01((falling - 0.8) / 0.2));
      gsap.set(logo, {
        autoAlpha: reveal * exitFade,
        scale: 0.9 + reveal * 0.1,
        xPercent: -50,
        y: (1 - reveal) * 12 + gravityOffset(canvasHeight.current, falling),
      });
    };

    useImperativeHandle(ref, () => ({
      setTimeline(masterTime) {
        let changed = false;
        const nextFall =
          masterTime >= SPONSORS_END && masterTime < SPONSORS_FALL_END
            ? clamp01((masterTime - SPONSORS_END) / (SPONSORS_FALL_END - SPONSORS_END))
            : 0;
        const fallChanged = Math.abs(fallProgress.current - nextFall) >= 0.0001;
        SPONSORS.forEach((sponsor, index) => {
          const active = masterTime >= sponsor.cue && masterTime < SPONSORS_FALL_END;
          const next = active
            ? clamp01((Math.min(masterTime, SPONSORS_END) - sponsor.cue) / sponsor.duration)
            : 0;
          const nextTwinkle = active ? (masterTime - sponsor.cue) / sponsor.duration : 0;
          const progressChanged = Math.abs(progresses.current[index] - next) >= 0.0001;
          const twinkleChanged = Math.abs(twinklePhases.current[index] - nextTwinkle) >= 0.0001;
          if (!progressChanged && !twinkleChanged && !fallChanged) return;

          progresses.current[index] = next;
          twinklePhases.current[index] = nextTwinkle;
          if (progressChanged || fallChanged) setLogoProgress(index, next, nextFall);
          changed = true;
        });
        fallProgress.current = nextFall;
        if (changed) renderer.current?.request();
      },
    }));

    useLayoutEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error("The fireworks canvas did not mount.");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("The browser could not create the fireworks canvas.");

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const lowPower = navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 4;
      const textSamples = SPONSORS.map((sponsor) => sampleText(sponsor.name));

      let width = 1;
      let height = 1;
      let prepared: PreparedSponsor[] = [];
      let canvasVisible = true;
      let raf = 0;
      let renderQueued = false;

      const prepareSponsor = (sponsorIndex: number): PreparedSponsor => {
        const phone = width < 760;
        const spec = sponsorAt(sponsorIndex, phone);
        const tier = FIREWORK_TIERS[spec.tier];
        const dimensions = phone ? tier.phone : tier.desktop;
        const sample = textSamples[sponsorIndex];
        const powerScale = phone ? 0.72 : lowPower ? 0.78 : 1;
        const budget = Math.round(tier.budget * powerScale);
        const points = pickEvenly(sample.points, budget);
        const sourceWidth = Math.max(1, sample.maxX - sample.minX);
        const sourceHeight = Math.max(1, sample.maxY - sample.minY);
        const targetWidth = width * dimensions.targetWidth;
        const targetHeight = height * dimensions.targetHeight;
        const textScale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
        const sourceCenterX = (sample.minX + sample.maxX) / 2;
        const sourceCenterY = (sample.minY + sample.maxY) / 2;
        const burstX = (spec.x / 100) * width;
        const burstY = (spec.y / 100) * height;
        const textCenterY = burstY + height * dimensions.textOffset;
        const random = randomSequence(0x9e3779b9 + sponsorIndex * 104729);

        const stars = points.map((point, index) => {
          const angle = (index / points.length) * TAU + (random() - 0.5) * 0.16;
          /* Most stars ride the outside of the bloom; a smaller inner group
           keeps the crack dense without introducing secondary particles. */
          const rim = index % 5 !== 0;
          const radius =
            height *
            (rim ? 0.14 + random() * 0.075 : 0.07 + random() * 0.075) *
            dimensions.burstScale;
          return {
            angle,
            radius,
            targetX: burstX + (point.x - sourceCenterX) * textScale,
            targetY: textCenterY + (point.y - sourceCenterY) * textScale,
            size: (0.72 + random() * 0.62) * dimensions.starScale,
            arc: (random() - 0.5) * height * 0.045,
            twinkleGroup: Math.floor(random() * TWINKLE_GROUPS),
            fallDelay: random() * 0.46,
            fallSpeed: 0.86 + random() * 0.28,
          };
        });

        return {
          burstX,
          burstY,
          burstScale: dimensions.burstScale,
          mortarX: (spec.from / 100) * width,
          mortarY: height * 1.06,
          stars,
        };
      };

      const prepare = () => {
        prepared = SPONSORS.map((_sponsor, index) => prepareSponsor(index));
      };

      const resize = () => {
        const box = canvas.getBoundingClientRect();
        width = Math.max(1, box.width);
        height = Math.max(1, box.height);
        canvasHeight.current = height;
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.25);
        canvas.width = Math.round(width * pixelRatio);
        canvas.height = Math.round(height * pixelRatio);
        context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        context.lineCap = "round";
        prepare();
      };

      const rocketPoint = (sponsor: PreparedSponsor, progress: number): DrawPoint => {
        const remaining = 1 - progress;
        const wobble = Math.sin(progress * Math.PI * 13) * width * 0.0035 * remaining;
        return {
          x: sponsor.mortarX + (sponsor.burstX - sponsor.mortarX) * progress + wobble,
          y: sponsor.burstY + (sponsor.mortarY - sponsor.burstY) * remaining * remaining,
        };
      };

      const burstPoint = (
        sponsor: PreparedSponsor,
        star: PreparedStar,
        progress: number,
      ): DrawPoint => {
        const expansion = easeOutCubic(clamp01(progress));
        return {
          x: sponsor.burstX + Math.cos(star.angle) * star.radius * expansion,
          y:
            sponsor.burstY +
            Math.sin(star.angle) * star.radius * expansion +
            height * 0.018 * progress * progress,
        };
      };

      const formedPoint = (
        sponsor: PreparedSponsor,
        star: PreparedStar,
        progress: number,
      ): DrawPoint => {
        const start = burstPoint(sponsor, star, 1);
        const travel = smoothstep(clamp01(progress));
        return {
          x: start.x + (star.targetX - start.x) * travel,
          y: start.y + (star.targetY - start.y) * travel + Math.sin(travel * Math.PI) * star.arc,
        };
      };

      const fallingPoint = (
        sponsor: PreparedSponsor,
        star: PreparedStar,
        formedProgress: number,
        falling: number,
      ): DrawPoint => {
        const point = formedPoint(sponsor, star, formedProgress);
        const individualFall = smoothstep(
          clamp01((falling - star.fallDelay) / (1 - star.fallDelay)),
        );
        return {
          x: point.x,
          y:
            point.y +
            height *
              (0.08 * individualFall + 0.92 * individualFall * individualFall) *
              star.fallSpeed,
        };
      };

      const drawRocket = (sponsor: PreparedSponsor, progress: number) => {
        const point = rocketPoint(sponsor, progress);
        const previous = rocketPoint(sponsor, Math.max(0, progress - 0.055));

        context.strokeStyle = "rgba(255, 132, 52, 0.38)";
        context.lineWidth = 7 * sponsor.burstScale;
        context.beginPath();
        context.moveTo(previous.x, previous.y);
        context.lineTo(point.x, point.y);
        context.stroke();

        context.strokeStyle = "rgba(255, 242, 210, 0.98)";
        context.lineWidth = 2.4 * Math.max(0.65, sponsor.burstScale);
        context.beginPath();
        context.moveTo(previous.x, previous.y);
        context.lineTo(point.x, point.y);
        context.stroke();

        /* A fixed tail sampled from the same scroll path: it never creates or
         retires particle objects while the user moves the wheel. */
        context.fillStyle = "rgba(255, 158, 72, 0.58)";
        context.beginPath();
        for (let index = 1; index <= 10; index += 1) {
          const tailProgress = Math.max(0, progress - index * 0.012);
          const tail = rocketPoint(sponsor, tailProgress);
          const radius = Math.max(0.4, (1.9 - index * 0.13) * sponsor.burstScale);
          context.moveTo(tail.x + radius, tail.y);
          context.arc(tail.x, tail.y, radius, 0, TAU);
        }
        context.fill();
      };

      const drawFlash = (sponsorIndex: number, sponsor: PreparedSponsor, progress: number) => {
        if (progress >= 0.52) return;
        const spec = SPONSORS[sponsorIndex];
        const flash = progress / 0.52;
        const radius = height * (0.055 + easeOutCubic(flash) * 0.25) * sponsor.burstScale;
        const alpha = 1 - flash;
        const gradient = context.createRadialGradient(
          sponsor.burstX,
          sponsor.burstY,
          0,
          sponsor.burstX,
          sponsor.burstY,
          radius,
        );
        gradient.addColorStop(0, `rgba(255, 255, 255, ${0.96 * alpha})`);
        gradient.addColorStop(0.28, `rgba(${channels(spec.core)}, ${0.54 * alpha})`);
        gradient.addColorStop(1, "rgba(0, 0, 0, 0)");
        context.fillStyle = gradient;
        context.beginPath();
        context.arc(sponsor.burstX, sponsor.burstY, radius, 0, TAU);
        context.fill();
      };

      const drawTwinkles = (
        sponsorIndex: number,
        sponsor: PreparedSponsor,
        phase: number,
        radiusScale: number,
        opacityScale: number,
        pointAt: (star: PreparedStar) => DrawPoint,
      ) => {
        const spec = SPONSORS[sponsorIndex];
        const paths = Array.from({ length: TWINKLE_GROUPS }, () => new Path2D());
        sponsor.stars.forEach((star) => {
          const point = pointAt(star);
          const radius = star.size * radiusScale;
          const path = paths[star.twinkleGroup];
          path.moveTo(point.x + radius, point.y);
          path.arc(point.x, point.y, radius, 0, TAU);
        });

        context.shadowBlur = 4;
        context.shadowColor = `rgba(${channels(spec.ember)}, ${0.9 * opacityScale})`;
        paths.forEach((path, group) => {
          const wave = Math.sin(phase * TAU * 2.6 + group * 1.67);
          const twinkle = (0.82 + wave * wave * 0.18) * opacityScale;
          context.fillStyle = `rgba(${channels(spec.core)}, ${twinkle})`;
          context.fill(path);
        });
        context.shadowBlur = 0;
        context.shadowColor = "transparent";
      };

      const drawBurst = (
        sponsorIndex: number,
        sponsor: PreparedSponsor,
        progress: number,
        twinklePhase: number,
      ) => {
        const spec = SPONSORS[sponsorIndex];
        drawFlash(sponsorIndex, sponsor, progress);
        context.beginPath();
        sponsor.stars.forEach((star) => {
          const point = burstPoint(sponsor, star, progress);
          const tail = burstPoint(sponsor, star, Math.max(0, progress - 0.075));
          context.moveTo(tail.x, tail.y);
          context.lineTo(point.x, point.y);
        });
        context.strokeStyle = `rgba(${channels(spec.ember)}, 0.52)`;
        context.lineWidth = 3.2 * sponsor.burstScale;
        context.stroke();
        context.strokeStyle = `rgba(${channels(spec.core)}, 0.98)`;
        context.lineWidth = 1.05 * Math.max(0.68, sponsor.burstScale);
        context.stroke();
        drawTwinkles(sponsorIndex, sponsor, twinklePhase, 0.9, 1, (star) =>
          burstPoint(sponsor, star, progress),
        );
      };

      const drawLetters = (
        sponsorIndex: number,
        sponsor: PreparedSponsor,
        progress: number,
        twinklePhase: number,
        falling: number,
      ) => {
        const formed = smoothstep(clamp01(progress));
        const opacity = 1 - smoothstep(clamp01((falling - 0.78) / 0.22));
        drawTwinkles(
          sponsorIndex,
          sponsor,
          twinklePhase * 1.35 + formed * 0.4,
          0.92 + formed * 0.18,
          opacity,
          (star) => fallingPoint(sponsor, star, progress, falling),
        );
      };

      const drawSponsor = (sponsorIndex: number) => {
        const progress = progresses.current[sponsorIndex];
        if (progress <= 0) return;
        const sponsor = prepared[sponsorIndex];

        if (progress < LAUNCH_END) {
          drawRocket(sponsor, progress / LAUNCH_END);
          return;
        }
        if (progress < BURST_END) {
          drawBurst(
            sponsorIndex,
            sponsor,
            (progress - LAUNCH_END) / (BURST_END - LAUNCH_END),
            twinklePhases.current[sponsorIndex],
          );
          return;
        }
        drawLetters(
          sponsorIndex,
          sponsor,
          clamp01((progress - BURST_END) / (FORM_END - BURST_END)),
          twinklePhases.current[sponsorIndex],
          fallProgress.current,
        );
      };

      const draw = () => {
        renderQueued = false;
        context.clearRect(0, 0, width, height);
        if (!canvasVisible || document.hidden || reduced) return;
        context.save();
        context.globalCompositeOperation = "lighter";
        SPONSORS.forEach((_sponsor, index) => drawSponsor(index));
        context.restore();
      };

      const requestRender = () => {
        if (renderQueued || !canvasVisible || document.hidden) return;
        renderQueued = true;
        raf = requestAnimationFrame(draw);
      };

      renderer.current = { request: requestRender };
      resize();
      SPONSORS.forEach((_sponsor, index) =>
        setLogoProgress(index, progresses.current[index], fallProgress.current),
      );
      requestRender();

      const onResize = () => {
        resize();
        SPONSORS.forEach((_sponsor, index) =>
          setLogoProgress(index, progresses.current[index], fallProgress.current),
        );
        requestRender();
      };
      window.addEventListener("resize", onResize);

      const intersectionObserver = new IntersectionObserver(([entry]) => {
        canvasVisible = entry?.isIntersecting ?? false;
        if (!canvasVisible) {
          cancelAnimationFrame(raf);
          renderQueued = false;
          context.clearRect(0, 0, width, height);
        } else {
          requestRender();
        }
      });
      intersectionObserver.observe(canvas);

      const onVisibilityChange = () => {
        if (document.hidden) {
          cancelAnimationFrame(raf);
          renderQueued = false;
        } else {
          requestRender();
        }
      };
      document.addEventListener("visibilitychange", onVisibilityChange);

      if (import.meta.env.DEV) {
        canvas.__peek = () => {
          const activeStars = progresses.current.reduce(
            (total, progress, index) => total + (progress > 0 ? prepared[index].stars.length : 0),
            0,
          );
          const letters = progresses.current.reduce(
            (total, progress, index) =>
              total + (progress >= BURST_END ? prepared[index].stars.length : 0),
            0,
          );
          return {
            progresses: [...progresses.current],
            stars: activeStars,
            letters,
            budgets: prepared.map((sponsor) => sponsor.stars.length),
            burstRadii: prepared.map((sponsor) =>
              Math.max(...sponsor.stars.map((star) => star.radius)),
            ),
            fallProgress: fallProgress.current,
          };
        };
      }

      return () => {
        renderer.current = null;
        cancelAnimationFrame(raf);
        intersectionObserver.disconnect();
        document.removeEventListener("visibilitychange", onVisibilityChange);
        window.removeEventListener("resize", onResize);
        delete canvas.__peek;
      };
    }, []);

    return (
      <div className="sponsors" id="sponsors">
        <canvas ref={canvasRef} className="fireworks" aria-hidden="true" />
        <h2 className="sponsors__title">Our Sponsors</h2>
        {SPONSORS.map((base, index) => {
          const spec = sponsorAt(index, narrow);
          const style = {
            left: `${spec.x}%`,
            top: `${spec.logoY}%`,
          };
          return (
            <a
              className="sponsor"
              data-tier={base.tier}
              href={base.href}
              key={base.name}
              rel="noreferrer"
              style={style}
              target="_blank"
              title={`Visit ${base.name}`}
              ref={(node) => {
                logoRefs.current[index] = node;
              }}
            >
              <img className={`sponsor__logo ${base.logoClass}`} src={base.logo} alt={base.name} />
            </a>
          );
        })}
      </div>
    );
  },
);

export default Fireworks;
