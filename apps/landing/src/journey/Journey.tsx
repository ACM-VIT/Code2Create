import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import Lanterns, { Wind } from "./Lanterns.js";
import { lanternAt } from "./lanternLayout.js";
import Fireworks, { type FireworksHandle } from "./Fireworks.js";
import Branches from "./Branches.js";
import Rosette from "./Rosette.js";
import { useFallingLadder } from "./fallingLadder/index.js";
import Cards, { Emblem } from "./Cards.js";
import {
  JOURNEY_SCROLL_DURATION,
  JOURNEY_SCROLL_SEGMENTS,
  journeyMasterTime,
  journeyScrollProgress,
} from "./timing.js";
import {
  LAYOUT,
  LOGO,
  CARD_RATIO,
  CARD_CLIP,
  wedgeClip,
  LOGO_BAND,
  STAR,
  STAR_REACH,
} from "./cardLayout.js";
import { Plant, createBloomTimeline } from "../timeline/botanical.js";
import { ideaSubmissionUrl } from "../lib/config.js";
import { JOURNEY_LEAP_EVENT, type JourneyLeapDetail } from "../lib/journeyLeap.js";
import FaqBoard from "./FaqBoard.js";
import type { PetalFieldHandle } from "./Petals.js";
import "./journey.css";

gsap.registerPlugin(useGSAP, ScrollTrigger);

/* The embedded preview loads the page with the document hidden, so rAF — and
   with it the ticker, the scrub and every cue — never fires there. Handing
   the internals to the console lets a test drive time by hand, the same way
   the petal field's __step does. */
if (import.meta.env.DEV && typeof window !== "undefined") {
  Object.assign(window, { __gsap: gsap, __scrollTrigger: ScrollTrigger });
}

/* Each About chapter is fronted by one of the five cards. */
const CHAPTERS = [
  /* Chapters follow the hand from left to right: ace for C2C, king for
     ACM-VIT, queen for ACM-W, jack for ACM, and 10 for VIT. */
  {
    title: "Code2Create",
    wordmark: true,
    card: 0,
    body: [
      "Code2Create is ACM-VIT’s flagship 48-hour national hackathon, uniting students across India to build innovative solutions.",
      "Tackle real-world challenges, collaborate with peers, and learn from industry mentors. Bring your vision, build your skills, and showcase your talent.",
    ],
  },
  {
    title: "ACM-VIT",
    card: 1,
    body: [
      "The official student chapter of the Association for Computing Machinery at VIT Vellore, pushing boundaries and challenging conventions since 2009 through research, open-source work, and unorthodox events.",
      "Homegrown projects like Conclave, UniPool, ExamCooker, and TAGRED deliver practical, high-impact solutions for our ecosystem, built by a community that grows together.",
    ],
  },
  {
    title: "ACM-W",
    card: 2,
    body: [
      "ACM-W at VIT brings together women interested in STEM and innovation, with a welcoming space to learn, connect, and grow through workshops, mentorship, and meaningful conversations.",
      "We help students discover their strengths, build confidence, and encourage more women to make their mark in STEM.",
    ],
  },
  {
    title: "ACM",
    card: 3,
    body: [
      "The Association for Computing Machinery is the world’s largest computing society, uniting over 100,000 educators, researchers, and professionals to advance computing as a science and a profession.",
      "Through 860 chapters, 38 Special Interest Groups, and the ACM Digital Library, it champions technical excellence, shapes public policy, and honors breakthroughs with the prestigious A.M. Turing Award.",
    ],
  },
  {
    title: "VIT",
    card: 4,
    body: [
      "Established in 1984, VIT Vellore stands among India’s premier engineering institutions, recognized for academic distinction, global exposure, and a relentless focus on innovation and research.",
      "With advanced infrastructure, distinguished educators, and an industry-aligned curriculum, VIT prepares students from across the globe to drive impact in every discipline.",
    ],
  },
];

/* The C2C 7.0 schedule, one phase per card, flipped through as the act
   scrubs by. Copy is condensed from the full format so each card reads in
   its slot. */
const TIMELINE_PHASES = [
  {
    title: "Code2Create 7.0",
    when: "Hackathon format",
    line: "An online idea submission, then a 48-hour offline build at VIT Vellore for the shortlisted teams.",
  },
  {
    title: "Round 0: Idea Submission",
    when: "31 Aug – 5 Sep 2026 · online",
    line: "Choose a problem statement and submit your solution with implementation details on the portal. External entries close 3 Sep, 11:59 PM IST, leaving time to plan travel; internal entries close 5 Sep. Shortlisted teams are invited to VIT Vellore.",
  },
  {
    title: "Opening Ceremony",
    when: "6 Sep · 2:00 – 3:00 PM IST",
    line: "The hackathon opens with the ceremony, followed by a walkthrough of the rules, judging criteria and important event information.",
  },
  {
    title: "Round 1: Ideation & Early Build",
    when: "6 Sep, 3:00 PM – 7 Sep, 12:00 AM IST",
    line: "Teams refine their ideas and start building their initial implementation and designs in preparation for the first review.",
  },
  {
    title: "Round 2: Progress Review",
    when: "7 Sep · 1:00 – 5:00 AM IST",
    line: "Teams present their idea, progress and implementation plan to mentors and judges and receive feedback.",
  },
  {
    title: "Round 3: Hacking Session",
    when: "7 Sep · 8:00 AM – 7:00 PM IST",
    line: "Teams continue building and improving their projects based on feedback from the previous review.",
  },
  {
    title: "Round 4: Final Review Prep",
    when: "7 Sep, 9:00 PM – 8 Sep, 12:00 AM IST",
    line: "Teams keep working on their projects and prepare their prototype and demo for the final evaluation round.",
  },
  {
    title: "Round 5: Prototype Evaluation",
    when: "8 Sep · 1:00 – 5:00 AM IST · eliminatory",
    line: "Teams demonstrate a functional prototype, its core features and their overall technical implementation. The highest-performing teams qualify for the final judging round.",
  },
  {
    title: "Round 6: Final Pitches & Judging",
    when: "8 Sep · 9:00 AM – 3:00 PM IST",
    line: "Finalists complete and deploy their solutions, then present them to the judging panel through a live demo and pitch. Winners are announced and felicitated at the closing ceremony.",
  },
];

/* Deterministic so the layout does not jump between renders. */
const EMBERS = [
  { left: 63, size: 60, duration: 34, delay: -4, sway: -70 },
  { left: 71, size: 40, duration: 44, delay: -19, sway: 52 },
  { left: 80, size: 76, duration: 38, delay: -27, sway: -40 },
  { left: 88, size: 48, duration: 48, delay: -11, sway: 64 },
  { left: 57, size: 34, duration: 52, delay: -33, sway: 38 },
  { left: 94, size: 64, duration: 41, delay: -40, sway: -56 },
  { left: 68, size: 28, duration: 58, delay: -23, sway: 46 },
];

/* One flat list with stable ids. A phone shows every one of them on a single
   ladder rather than dropping half the answers, and the id a panel is keyed by
   does not change when the breakpoint does. */
const FAQ = [
  {
    id: "register",
    q: "Who can submit an idea?",
    a: "Students from all over the country are eligible to participate in Code2Create. Everybody is welcome to make a difference.",
  },
  {
    id: "cost",
    q: "What will the hackathon cost me?",
    a: "Nothing, it’s absolutely free. You cannot put a price on groundbreaking ideas.",
  },
  {
    id: "hardware",
    q: "Can I implement my idea in hardware?",
    a: "Sure! There’s no bias between software and hardware. But you’ll have to bring your own hardware.",
  },
  {
    id: "kind",
    q: "What kind of hackathon is Code2Create?",
    a: "Code2Create is a tech-based hackathon.",
  },
  {
    id: "team",
    q: "How many members can constitute a team?",
    a: "A team must have 2 to 5 members. Each member needs their own account on the Code2Create participant portal.",
  },
  {
    id: "stay",
    q: "Will there be accommodation for external participants?",
    a: "Yes, we will provide accommodation at VIT.",
  },
  {
    id: "how",
    q: "How do I submit an idea?",
    a: "Open the Code2Create participant portal, sign in, complete your team, and submit your idea.",
  },
  {
    id: "early",
    q: "Can I start working on my hack before the hackathon?",
    a: "No, you are not permitted to work on pre-existing projects in the hackathon. To maintain fair standards of judgment you will begin working on your hack after reporting to the venue.",
  },
  {
    id: "tech",
    q: "Is the hackathon only about technology?",
    a: "We are tech enthusiasts but we believe “all work and no play makes Jack a dull boy.” We have numerous fun activities planned for you.",
  },
  {
    id: "judging",
    q: "What will be the judging criteria?",
    a: "Innovation, relevance to the problem, technical complexity, implementation and functionality, UI/UX, scalability and future scope, novelty and presentation.",
  },
  {
    id: "benefit",
    q: "How will I benefit from attending this hackathon?",
    a: "Code2Create is a place for innovators to create and make a difference. You will get an opportunity to interact with ingenious minds. In addition, we have cash prizes, licenses, schwags, cloud credits and goodies for the winner.",
  },
  {
    id: "travel",
    q: "Will there be travel reimbursements provided?",
    a: "Travel reimbursement is not provided for external participants.",
  },
];

interface JourneyProps {
  petalsRef: RefObject<PetalFieldHandle | null>;
}

interface EmberStyle extends CSSProperties {
  "--sway": string;
}

function emberStyle(ember: (typeof EMBERS)[number]): EmberStyle {
  return {
    left: `${ember.left}%`,
    width: `${ember.size}px`,
    animationDuration: `${ember.duration}s`,
    animationDelay: `${ember.delay}s`,
    "--sway": `${ember.sway}px`,
  };
}

export default function Journey({ petalsRef }: JourneyProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const fireworksRef = useRef<FireworksHandle>(null);

  /* Two ladders side by side, or one long one on a phone. Every question is on
     the page either way — a phone used to be shown half of them. */
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches,
  );

  /*
   * The FAQ act runs as a simulation, not as part of the scrubbed timeline: a
   * fall stepped through by a scroll wheel is not a fall. The timeline only
   * cues it, and the act owns its own boughs and panel from there. `narrow`
   * is the remount key: the breakpoint rebuilds the columns, and the act must
   * re-capture them or it keeps measuring detached DOM.
   */
  const ladder = useFallingLadder(stageRef, narrow);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const ladderColumns = useMemo(() => (narrow ? [FAQ] : [FAQ.slice(0, 6), FAQ.slice(6)]), [narrow]);

  useGSAP(
    () => {
      const root = rootRef.current;
      const stage = stageRef.current;
      if (!root || !stage) throw new Error("The journey stage did not mount.");
      const q = gsap.utils.selector(stage);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const cards = q(".card");
      const ridges = {
        far: q(".ridge--far")[0],
        mid: q(".ridge--mid")[0],
        near: q(".ridge--near")[0],
      };
      const lanterns = q(".lantern");
      const panels = q(".chapter");

      /* Geometry is read fresh rather than captured, so a resize (which makes
         ScrollTrigger refresh and invalidate) re-evaluates it against the new
         breakpoint and stage aspect. */
      const phone = () => window.matchMedia("(max-width: 760px)").matches;
      const base = () => (phone() ? LAYOUT.phone : LAYOUT.wide);

      /* Card widths are given as a % of stage width, which on a short stage
         makes them far too tall — the featured card ends up over the copy.
         Cap the resulting height and let the width follow. */
      const fit = (widthPct: number, maxHeightFraction: number) => {
        const box = stage.getBoundingClientRect();
        const maxWidth = ((box.height * maxHeightFraction * CARD_RATIO) / box.width) * 100;
        return Math.min(widthPct, maxWidth);
      };

      const layout = () => {
        const source = base();
        const fanWidth = fit(source.fanWidth, phone() ? 0.24 : 0.34);
        const featureWidth = fit(source.feature.width, phone() ? 0.24 : 0.46);
        return {
          fan: source.fan,
          fanWidth,
          feature: {
            ...source.feature,
            width: featureWidth,
            /* Keep it centred on where it would have sat. */
            left: source.feature.left + (source.feature.width - featureWidth) / 2,
          },
        };
      };

      const logo = () => {
        const box = phone() ? LOGO.phone : LOGO.wide;
        const short = window.innerHeight < 620;
        const width = fit(short ? box.width * 0.62 : box.width, 0.26);
        return { width, top: short ? 15 : box.top, left: 50 - width / 2 };
      };

      /* A card's height as a % of stage height, for a given width %. */
      const cardHeight = (widthPct: number) => {
        const box = stage.getBoundingClientRect();
        return (((widthPct / 100) * box.width) / CARD_RATIO / box.height) * 100;
      };

      /* The card box that lays its wedge exactly over the emblem. */
      const overEmblem = () => {
        const box = logo();
        return {
          left: `${box.left}%`,
          top: `${box.top - LOGO_BAND.offset * cardHeight(box.width)}%`,
          width: `${box.width}%`,
        };
      };

      const setStartState = () => {
        const at = overEmblem();
        const box = logo();

        /* The emblem is placed from the same numbers as the cards, so the two
           can never drift apart across breakpoints. */
        gsap.set(q(".emblem-holder"), {
          left: `${box.left}%`,
          top: `${box.top}%`,
          width: `${box.width}%`,
        });

        cards.forEach((card, index) => {
          gsap.set(card, {
            ...at,
            rotation: 0,
            clipPath: wedgeClip(index),
            borderRadius: 0,
            autoAlpha: 0,
            zIndex: 10 + index,
          });
        });
      };

      /* ---------------- initial state ---------------- */

      gsap.set(q(".hero-copy"), { xPercent: -50, autoAlpha: 1 });
      gsap.set(q(".hero-tree"), { xPercent: 0, autoAlpha: 1 });
      gsap.set(q(".emblem-holder"), { autoAlpha: 1 });
      gsap.set(q(".emblem__wedges"), { autoAlpha: 1 });
      setStartState();
      gsap.set(q(".card__face"), { autoAlpha: 0 });
      gsap.set(q(".card__wedge"), { autoAlpha: 1 });

      gsap.set(ridges.mid, { yPercent: 120 });
      gsap.set(q(".lantern__label"), { autoAlpha: 0 });
      /* The title rides in from above with the clearing sky and settles into
         the open band at its foot before the first sponsor shell launches. */
      gsap.set(q(".sponsors__title"), { autoAlpha: 0, y: "-100svh" });
      gsap.set(panels, { autoAlpha: 0, xPercent: 8 });
      gsap.set(q(".bonsai"), { xPercent: 135, autoAlpha: 0 });
      gsap.set(q(".branches"), { autoAlpha: 1 });
      gsap.set(q(".wind"), { autoAlpha: 0 });
      gsap.set(q(".sky-dim"), { autoAlpha: 0 });

      /* ---------------- master timeline ---------------- */

      const tl = gsap.timeline({ defaults: { ease: "none" } });

      /* A — hero holds while the petals come off the tree. */
      tl.to({}, { duration: 6 }, 0);

      /* B — the world pans east and the hero copy walks off to the left. The
         emblem stays exactly where it is; it is about to become the cards.
         The pan finishes as the spread lands: once the hand is in place the
         hills must be still, or the cards look like they are sliding. */
      const pan = (target: gsap.TweenTarget, distance: number) =>
        tl.to(
          target,
          { backgroundPositionX: `-=${distance}`, duration: 22, ease: "power2.out" },
          6,
        );
      pan(ridges.near, 1500);
      pan(ridges.mid, 920);
      pan(ridges.far, 520);

      tl.to(
        q(".hero-copy"),
        { xPercent: -178, autoAlpha: 0, duration: 7, ease: "power2.in" },
        6,
      ).to(q(".hero-tree"), { xPercent: -120, duration: 9, ease: "power2.in" }, 6);

      /* C — the mark opens up. First the white rim and dark ground fade out,
         leaving only the five coloured wedges; the cards take those over on a
         frame where nothing is moving, so the hand-off cannot be seen. */
      tl.to(q(".emblem__shell"), { autoAlpha: 0, duration: 2.6, ease: "power2.inOut" }, 11.5)
        .set(cards, { autoAlpha: 1 }, 14.2)
        .set(q(".emblem__wedges"), { autoAlpha: 0 }, 14.2)
        .set(q(".emblem-holder"), { autoAlpha: 0 }, 14.2);

      /* D — the wedges revolve out into a five-pointed star. */
      cards.forEach((card, index) => {
        const star = STAR[index];
        tl.to(
          card,
          {
            rotation: star.spin,
            xPercent: star.dx * STAR_REACH * 100,
            yPercent: star.dy * STAR_REACH * 100 * CARD_RATIO,
            duration: 7,
            ease: "power2.inOut",
          },
          14.4,
        );
      });

      /* E — each ray becomes a card AT THE MARK'S OWN SIZE, and only then
         flies down to the fan. The morph and the flight used to overlap,
         and on a phone — where a fan card is far smaller than the mark —
         the still-morphing triangles visibly shrank mid-unfold. Now the
         triangle keeps the logo's scale until it is fully a card, and any
         resize happens on the way to the hand. */
      cards.forEach((card, index) => {
        tl.to(
          card,
          {
            clipPath: CARD_CLIP,
            borderRadius: 16,
            duration: 3,
            ease: "power2.inOut",
          },
          21.6 + index * 0.35,
        ).to(
          card,
          {
            left: () => `${layout().fan[index].left}%`,
            top: () => `${layout().fan[index].top}%`,
            width: () => `${layout().fanWidth}%`,
            rotation: () => layout().fan[index].rotate,
            xPercent: 0,
            yPercent: 0,
            duration: 5,
            ease: "power2.inOut",
          },
          24.8 + index * 0.35,
        );
      });

      tl.to(q(".card__wedge"), { autoAlpha: 0, duration: 2.6 }, 25).to(
        q(".card__face"),
        { autoAlpha: 1, duration: 2.4, stagger: 0.2 },
        26.5,
      );

      /* D/E/F — each chapter lifts its card out of the fan, holds, returns.
         Five chapters now, so the beat is 7s rather than 9s — the last
         card is back in the hand at 68.6, before the drop at 70. */
      CHAPTERS.forEach((chapter, index) => {
        const at = 32 + index * 7;
        const card = cards[chapter.card];

        tl.to(
          card,
          {
            left: () => `${layout().feature.left}%`,
            top: () => `${layout().feature.top}%`,
            width: () => `${layout().feature.width}%`,
            rotation: () => layout().feature.rotate,
            zIndex: 40,
            duration: 2.2,
            ease: "power3.out",
          },
          at,
        )
          .to(
            panels[index],
            { autoAlpha: 1, xPercent: 0, duration: 1.8, ease: "power2.out" },
            at + 0.7,
          )
          .to(
            panels[index],
            { autoAlpha: 0, xPercent: -6, duration: 1.4, ease: "power2.in" },
            at + 6.1,
          )
          .to(
            card,
            {
              left: () => `${layout().fan[chapter.card].left}%`,
              top: () => `${layout().fan[chapter.card].top}%`,
              width: () => `${layout().fanWidth}%`,
              rotation: () => layout().fan[chapter.card].rotate,
              zIndex: 10 + chapter.card,
              duration: 2.2,
              ease: "power3.inOut",
            },
            at + 6.4,
          );
      });

      /* G — the hand slides away under the hills and the middle ridge swells
         up. Then a hard gust blows the lanterns in from the left: they are
         carried horizontally and float up on their own buoyancy, the way a
         balloon does, so x and y run on different curves. */
      tl.to(
        cards,
        { yPercent: 175, autoAlpha: 0, duration: 6, stagger: 0.3, ease: "power2.in" },
        70,
      )
        .to(ridges.mid, { yPercent: 0, duration: 9, ease: "power2.out" }, 71)
        .to(q(".embers"), { autoAlpha: 0, duration: 5 }, 70)
        .to(q(".wind"), { autoAlpha: 1, duration: 4 }, 71);

      lanterns.forEach((lantern, index) => {
        const spec = lanternAt(index, phone());
        const entry = -(spec.x + spec.size + 8);
        gsap.set(lantern, { x: `${entry}vw`, y: `${spec.drop}vh`, autoAlpha: 0 });

        tl.to(lantern, { autoAlpha: 1, duration: 2 }, 72 + index * 1.6)
          /* Blown across — fast at first, then the gust lets go. */
          .to(lantern, { x: 0, duration: 20, ease: "power2.out" }, 72 + index * 1.6)
          /* And rising all the while, easing out as it finds its level. */
          .to(lantern, { y: 0, duration: 24, ease: "sine.out" }, 72 + index * 1.6);
      });

      tl.to(q(".lantern__label"), { autoAlpha: 1, duration: 3, stagger: 0.8 }, 86);

      /* H — the wind takes the lanterns away while every ridge drops below
         the stage. The sponsor act begins only after the sky is fully clear. */
      tl.to(q(".lantern__label"), { autoAlpha: 0, duration: 2.5 }, 94)
        .to(q(".wind"), { autoAlpha: 0, duration: 4 }, 96)
        .to(
          lanterns,
          { x: "86vw", y: "-52vh", autoAlpha: 0, duration: 7, stagger: 0.5, ease: "power2.in" },
          95,
        )
        .to([ridges.near, ridges.mid], { yPercent: 130, duration: 8, ease: "power2.inOut" }, 95)
        .to(ridges.far, { yPercent: 130, duration: 7.5, ease: "power2.inOut" }, 95.5);

      /* H2 — the title travels with the descending background and reaches the
         bottom of the cleared sky before the sponsor volley begins. Every
         firecracker phase is scrubbed by this timeline: stop the wheel and
         the shell stops; reverse it and the shell rewinds. */
      tl.to(q(".sponsors__title"), { autoAlpha: 1, y: 0, duration: 8, ease: "power2.inOut" }, 95).to(
        q(".sponsors__title"),
        { autoAlpha: 0, y: "18svh", duration: 8, ease: "power2.in" },
        142,
      );

      /* H3 — wash the clear sponsor sky into the ink of the timeline act. */
      tl.to(q(".sky-dim"), { autoAlpha: 1, duration: 10, ease: "power1.inOut" }, 141);

      /* I — the bonsai slides in from the right and blooms inside a swirl of
         petals that crosses the whole frame. */
      tl.to(q(".bonsai"), { xPercent: 0, autoAlpha: 1, duration: 6, ease: "power3.out" }, 150);

      /* The great blossom behind the day card: it fades up with the act and
         turns slowly under the scroll — those stay scrubbed — but the five
         petals do NOT. A scrubbed stagger is compressed into however long
         the user spends crossing its scroll span, which at any real pace is
         a blink, and it never read as one-by-one. Instead each petal pops
         in REAL time — 0.55s with a little overshoot — the moment the
         playhead crosses its mark, exactly the way the ladder act is cued,
         so the sequence reads petal by petal at any scroll speed and folds
         back petal by petal on the way up. The container is fully dark well
         before the act ends, so the FAQ act opens on a bare stage. */
      const rosette = q(".rosette")[0];
      const rosettePetals = q(".rosette__petal");
      gsap.set(rosette, { xPercent: -50, yPercent: -50, autoAlpha: 0, rotation: -24 });
      gsap.set(rosettePetals, {
        autoAlpha: 0,
        scale: 0.78,
        rotation: -9,
        transformOrigin: "50% 100%",
      });
      tl.to(rosette, { autoAlpha: 0.85, duration: 2.5 }, 151)
        .to(rosette, { rotation: 36, duration: 122, ease: "none" }, 151)
        .to(rosette, { autoAlpha: 0, duration: 2.6 }, 273.4);

      const petalShown = rosettePetals.map(() => false);
      const rosetteCue = (progress: number, immediate = false) => {
        const at = journeyMasterTime(progress);
        rosettePetals.forEach((petal, index) => {
          const wanted = at >= 154 + index * 22;
          if (wanted === petalShown[index] && !immediate) return;
          petalShown[index] = wanted;
          if (immediate) {
            gsap.killTweensOf(petal);
            gsap.set(
              petal,
              wanted
                ? { autoAlpha: 1, scale: 1, rotation: 0 }
                : { autoAlpha: 0, scale: 0.78, rotation: -9 },
            );
            return;
          }
          gsap.to(
            petal,
            wanted
              ? {
                  autoAlpha: 1,
                  scale: 1,
                  rotation: 0,
                  duration: 0.55,
                  ease: "back.out(1.6)",
                  overwrite: "auto",
                }
              : {
                  autoAlpha: 0,
                  scale: 0.78,
                  rotation: -9,
                  duration: 0.4,
                  ease: "power2.in",
                  overwrite: "auto",
                },
          );
        });
      };

      /* Scoped to the bonsai so it does not also grab the branch flowers.
         The timeline act runs at five times its old scroll span (150–280),
         and the bloom is timed to complete at 255 — the moment the LAST
         phase card arrives — so the pot is fully grown exactly when the
         schedule finishes telling itself. */
      const bonsaiBloom = createBloomTimeline(q(".bonsai")[0], { moments: false });
      tl.add(bonsaiBloom.duration(104), 151);

      /* Fade and rise only — no blur() in these: a filter tween on live text
         repaints the card on every scrubbed frame, and this act already pays
         for the bloom. Nine phase cards share the act evenly; the last one
         holds until the container fades. */
      const days = q(".day");
      gsap.set(days, { autoAlpha: 0, y: 26 });
      tl.to(q(".days"), { autoAlpha: 1, duration: 2 }, 152);
      const DAY_SLOT = 115 / days.length;
      days.forEach((day, index) => {
        const at = 152 + index * DAY_SLOT;
        /* Strictly sequential: the outgoing card is fully gone before the next
           one starts to rise. Overlapping the two crossfaded a pair of
           half-opaque boxes over each other, which read as ghosting. */
        tl.to(day, { autoAlpha: 1, y: 0, duration: DAY_SLOT * 0.3 }, at + 0.35);
        if (index < days.length - 1) {
          tl.to(day, { autoAlpha: 0, y: -26, duration: DAY_SLOT * 0.26 }, at + DAY_SLOT * 0.7);
        }
      });
      tl.to(q(".days"), { autoAlpha: 0, duration: 3 }, 267);

      /*
       * J/K — the bonsai leaves, and the FAQ act takes over. The boughs being
       * hauled back and released, the roll being paid out and the ladder
       * settling are all simulated in real time by `useFallingLadder`; the
       * timeline's only job is to say when. Scrolling back up past the cue
       * reels the ladder in again.
       *
       * The bonsai is fully out at 276.5 — exactly the reel's door — so
       * while the rig is being hauled off, the stage behind it is bare:
       * no act re-enters until the reel has finished and the door opens.
       */
      tl.to(q(".bonsai"), { xPercent: 135, autoAlpha: 0, duration: 4, ease: "power2.in" }, 272.5);

      const FAQ_CUE = 280;
      /* Hysteresis: the fall cues at 280, but the reel does not begin until
         the scroll has climbed clearly back past 277.5 — hiding the answers
         takes a deliberate bit of excess scroll, not a grazed threshold. */
      const FAQ_OFF = 277.5;
      /* The act's doors, in timeline seconds. While the ladder is FALLING
         the scroll is walled at EXIT — deliberately BEFORE the camera
         tilt's span (282.5+), so the drop always settles onto a still
         stage and the pan only begins once the rig is home; the ladder can
         never be dragged upward mid-appearance again. While REELING the
         scroll holds at ENTRY, where the stage behind the rig is bare (the
         bonsai act's furniture is gone by 276.5). */
      const FAQ_EXIT = 282;
      const FAQ_ENTRY = 276.5;

      /* L — the FAQ act's scroll span, ending the moment the shed reaches
         full at 290: the fall keeps playing into the footer on its own, so
         holding the timeline open past it only made dead scroll. */
      tl.to({}, { duration: 8 }, 282);

      /* M — the camera tilt. On layouts where the ladder is taller than the
         frame — a phone's single column, a short tablet — the whole act pans
         upward across the span, boughs and shell together so the knots never
         part from the wood, bringing the tail rungs on screen before the
         footer arrives. Wide stages measure zero overflow and never move.
         offsetTop/offsetHeight are layout values, untouched by the act's
         transforms, so the measure is exact even taken mid-fall. */
      const faqShell = q(".faq-shell")[0];
      const faqBranches = q(".branches")[0];
      /* 72px of clear air under the last rung, so the ladder's tail floats
         free of the section edge instead of sitting on it. */
      const faqOverflow = () =>
        Math.max(0, faqShell.offsetTop + faqShell.offsetHeight + 72 - stage.clientHeight);
      /* fromTo, not to: on a refresh mid-act an invalidated .to() re-captures
         its start from the CURRENT translate, so the rig jumped by however
         far the tilt had already run. An explicit 0 start keeps the mapping
         anchored no matter when ScrollTrigger re-measures. */
      tl.fromTo(
        [faqBranches, faqShell],
        { y: 0 },
        { y: () => -faqOverflow(), duration: 7.5, ease: "none", immediateRender: false },
        282.5,
      );

      /* ---------------- petals, cued off overall progress ------------- */

      /* Past the cue the ladder is out; back above the OFF line, reeled in.
         Two thresholds, not one: a single line re-triggered the act on the
         smallest wobble around it. The hook itself ignores a repeat of what
         it is already doing. */
      let faqOn = false;
      const ladderCue = (progress: number, immediate = false) => {
        const at = journeyMasterTime(progress);
        if (!faqOn && at >= FAQ_CUE) faqOn = true;
        else if (faqOn && at < FAQ_OFF) faqOn = false;
        ladder.setActive(faqOn, immediate);
      };

      /* Firework progress comes only from scroll. Past its own span a sponsor
         holds in its resolved state, then every particle and logo falls with
         the departing hills; crossing backward rewinds those exact positions. */
      const sponsorCue = (progress: number) => {
        const api = fireworksRef.current;
        if (!api) return;
        api.setTimeline(journeyMasterTime(progress));
      };

      const petalCue = (progress: number) => {
        const api = petalsRef.current;
        if (!api) return;
        const at = journeyMasterTime(progress);
        const ramp = (from: number, to: number) =>
          gsap.utils.clamp(0, 1, (at - from) / (to - from));

        /* The petal canvas paints over the whole pinned stage, so the
           timeline's routed river cannot be layered behind the FAQ ladder —
           instead it is retired outright the moment the FAQ act owns the
           stage, and rebuilt when the scroll returns to the timeline. */
        /* The purge boundary matches the reel's hysteresis line (277.5),
           not the fall cue: between the two the rig can still be out, and
           a river alive there painted straight over the planks. And while
           the act is mid-play in either direction, the river stays dead
           regardless of where the scroll sits — it may never cross the
           rig. */
        api.setPurge("path", at >= 277.5 || ladder.getBusy() !== null);

        if (at < 15) {
          /* Strictly the hero: shed from the canopy itself, and sparsely. */
          api.setMode("canopy");
          api.setWind(0.08);
          api.setIntensity(0.12);
        } else if (at > 71 && at < 103) {
          /* Caught in the same gust that carries the lanterns — kept sparse so
             the stats stay legible. */
          api.setMode("drift");
          api.setWind(3.4);
          api.setIntensity(0.08 * ramp(71, 77) * (1 - ramp(96, 103)));
        } else if (at >= 149 && at < 277.5) {
          /* Carried slowly along the act's own route — down the left, across
             the floor, up the right — rather than milling about the middle. */
          api.setMode("path");
          api.setWind(0);
          api.setIntensity(ramp(149, 154));
        } else if (at >= 283) {
          /* Shed by the boughs, and still falling as the footer takes over —
             a light fall, so the questions stay the point of the act. */
          api.setMode("drift");
          api.setWind(0.5);
          api.setIntensity(0.085 * ramp(283, 290));
        } else {
          /* Between acts — which now includes the sponsor volley, whose sky
             stays clear for the shells. Handing the mode to 'drift' marks any
             routed petals as strangers, which die fast — a quick scroll into
             the FAQ act must not carry the timeline's river along with it. */
          api.setMode("drift");
          api.setIntensity(0);
        }
      };

      /*
       * The tow must be watched whole: while the ladder is being hauled back
       * in, the scroll is walled at the reel's door and let go the moment
       * the rig is off. Only the reverse direction is gated — a fall never
       * holds the scroll. A nav jump bypasses the wall and resolves the rig
       * immediately; grabbing the wheel re-arms it. Enforcement is an instant
       * scroll: the page's own smooth behavior would turn the wall to rubber.
       */
      /* The scroll timeline carries a weighted playhead over the unchanged
         choreography. This doubles the wheel distance for About and the
         sponsor reveals, while the sponsor exit returns to normal speed. */
      tl.pause(0);
      const playhead = { at: 0 };
      const syncMaster = () => tl.time(playhead.at);
      const scrollTimeline = gsap.timeline({ paused: true, defaults: { ease: "none" } });
      JOURNEY_SCROLL_SEGMENTS.forEach((segment) => {
        scrollTimeline.to(playhead, {
          at: segment.to,
          duration: (segment.to - segment.from) * segment.distanceScale,
          onUpdate: syncMaster,
        });
      });

      let leapUntil = 0;
      let leapInProgress = false;
      const grab = () => {
        leapUntil = 0;
      };

      const gate = (self: ScrollTrigger) => {
        const busy = ladder.getBusy();
        if (!busy) return;
        if (performance.now() < leapUntil) return;
        const wallProgress = journeyScrollProgress(busy === "fall" ? FAQ_EXIT : FAQ_ENTRY);
        const wall = self.start + wallProgress * (self.end - self.start);
        const at = self.scroll();
        if (busy === "fall" ? at > wall : at < wall) {
          window.scrollTo({ top: wall, behavior: "auto" });
        }
      };

      const trigger = ScrollTrigger.create({
        animation: scrollTimeline,
        trigger: root,
        start: "top top",
        end: "bottom bottom",
        /* Enough catch-up to glide, little enough to feel free under the
           wheel. */
        scrub: reduced ? true : 0.7,
        invalidateOnRefresh: true,
        onRefreshInit: () => {
          /* Card geometry depends on the breakpoint and the stage's aspect, so
             re-seed the start box before ScrollTrigger re-measures. */
          if (tl.progress() === 0) setStartState();
        },
        onUpdate: (self) => {
          petalCue(self.progress);
          ladderCue(self.progress, leapInProgress);
          rosetteCue(self.progress, leapInProgress);
          sponsorCue(self.progress);
          gate(self);
        },
        onRefresh: (self) => {
          petalCue(self.progress);
          ladderCue(self.progress);
          rosetteCue(self.progress);
          sponsorCue(self.progress);
        },
      });

      const leap = (event: CustomEvent<JourneyLeapDetail>) => {
        const progress = event.detail.progress;
        leapUntil = performance.now() + 2000;
        leapInProgress = true;
        trigger.getTween()?.pause();
        scrollTimeline.progress(progress);
        syncMaster();
        trigger.update();
        trigger.getTween()?.progress(1);
        scrollTimeline.progress(progress);
        syncMaster();
        petalCue(progress);
        ladderCue(progress, true);
        rosetteCue(progress, true);
        sponsorCue(progress);
        leapInProgress = false;
      };

      /* The trigger stops reporting once its progress pegs at an end, so the
         walls also stand on the raw scroll — added after the trigger, which
         keeps them downstream of the cue that starts the act. */
      const guard = () => gate(trigger);
      window.addEventListener("scroll", guard, { passive: true });

      /* Deliberately NO ResizeObserver on the shell: refreshing the trigger
         every time an answer opened re-targeted the tilt and yanked the
         whole rig vertically mid-read. The tilt's clearance absorbs an open
         answer instead, and real viewport resizes still refresh normally. */
      window.addEventListener(JOURNEY_LEAP_EVENT, leap);
      window.addEventListener("wheel", grab, { passive: true });
      window.addEventListener("touchstart", grab, { passive: true });

      if (scrollTimeline.duration() !== JOURNEY_SCROLL_DURATION) {
        throw new Error("The journey scroll timing does not match its segment map.");
      }

      petalCue(0);
      /* Cue again once mounting has fully settled, so the opening state cannot
         depend on which component attached its ref first. */
      const settledCue = requestAnimationFrame(() => {
        petalCue(trigger.progress);
        sponsorCue(trigger.progress);
      });

      /* The stage is built from large artwork that is still decoding when the
         trigger is created, so its end offset can come out unmeasured. Force a
         measure now, once every image has landed, and once more on load. */
      const refresh = () => ScrollTrigger.refresh();
      refresh();
      const images = Array.from(stage.querySelectorAll<HTMLImageElement>("img"));
      const pending = images.filter((img) => !img.complete);
      pending.forEach((img) => {
        img.addEventListener("load", refresh, { once: true });
        img.addEventListener("error", refresh, { once: true });
      });

      if (document.readyState === "complete") {
        requestAnimationFrame(refresh);
      } else {
        window.addEventListener("load", refresh, { once: true });
      }

      return () => {
        cancelAnimationFrame(settledCue);
        window.removeEventListener("load", refresh);
        window.removeEventListener("scroll", guard);
        window.removeEventListener(JOURNEY_LEAP_EVENT, leap);
        window.removeEventListener("wheel", grab);
        window.removeEventListener("touchstart", grab);
        pending.forEach((img) => img.removeEventListener("load", refresh));
        trigger.kill();
      };
    },
    { scope: rootRef },
  );

  return (
    <div className="journey" ref={rootRef}>
      <div className="journey__stage scene" ref={stageRef}>
        <div className="sky" aria-hidden="true" />
        <div className="sky-dim" aria-hidden="true" />

        <div className="ridge ridge--far" aria-hidden="true" />

        {/* Sky lanterns drifting up from behind the hills. */}
        <div className="embers" aria-hidden="true">
          {EMBERS.map((ember, index) => (
            <img key={index} src="/assets/img/lantern.png" alt="" style={emberStyle(ember)} />
          ))}
        </div>

        <div className="ridge ridge--mid" aria-hidden="true" />

        <Wind />
        <Lanterns stageRef={stageRef} />
        <Fireworks ref={fireworksRef} />
        <Cards />

        <div className="ridge ridge--near" aria-hidden="true" />

        <img className="hero-tree" src="/assets/img/tree.webp" alt="" aria-hidden="true" />

        <Branches />

        {/* ---------- hero ---------- */}
        <div className="emblem-holder">
          <Emblem />
        </div>

        <div className="hero-copy">
          <h1 className="hero-wordmark">
            <img src="/assets/svg/wordmark.svg" alt="Code2Create" width="669" height="85" />
          </h1>
          <p className="hero-tagline">Don’t just code for the vibes, Code2Create.</p>
          <a className="hero-cta" href={ideaSubmissionUrl}>
            <img src="/assets/svg/btn-box.svg" alt="" aria-hidden="true" />
            <span>Submit idea</span>
          </a>
          <p className="hero-venue">6th September, 2026 · Anna Auditorium, VIT Vellore</p>
        </div>

        {/* ---------- about chapters ---------- */}
        <div className="chapters" id="about">
          {CHAPTERS.map((chapter) => (
            <article className="chapter" key={chapter.title}>
              <h2 className="chapter__title">
                <span>About</span>{" "}
                {chapter.wordmark === true ? (
                  <img
                    src="/assets/svg/wordmark-sm.svg"
                    alt="Code2Create"
                    width="288"
                    height="37"
                  />
                ) : (
                  <span className="chapter__name">{chapter.title}</span>
                )}
              </h2>
              <div className="chapter__body">
                {chapter.body.map((paragraph) => (
                  <p key={paragraph.slice(0, 24)}>{paragraph}</p>
                ))}
              </div>
            </article>
          ))}
        </div>

        <h2 className="visually-hidden" id="stats">
          Code2Create by the numbers
        </h2>

        {/* ---------- timeline ---------- */}
        <Rosette />
        <div className="bonsai" id="timeline">
          <Plant />
        </div>
        <div className="days">
          {TIMELINE_PHASES.map((slot, index) => (
            <article className="moment day" key={slot.title} aria-hidden={index !== 0}>
              <h3 className="day__title">{slot.title}</h3>
              <p className="day__when">{slot.when}</p>
              <p className="day__body">{slot.line}</p>
            </article>
          ))}
        </div>

        {/* ---------- FAQs ---------- */}
        <div className="faq-shell" id="faqs">
          <h2 className="visually-hidden">Frequently asked questions</h2>
          <FaqBoard columns={ladderColumns} />
        </div>
      </div>
    </div>
  );
}
