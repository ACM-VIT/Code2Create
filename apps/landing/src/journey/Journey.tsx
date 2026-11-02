import { useRef, type CSSProperties, type RefObject } from "react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import Lanterns, { Wind } from "./Lanterns.js";
import { lanternAt } from "./lanternLayout.js";
import Fireworks, { type FireworksHandle } from "./Fireworks.js";
import Cards, { Emblem } from "./Cards.js";
import {
  JOURNEY_SCROLL_DURATION,
  JOURNEY_SCROLL_SEGMENTS,
  journeyMasterTime,
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
import {
  JOURNEY_LEAP_EVENT,
  type JourneyLeapDetail,
} from "../lib/journeyLeap.js";
import type { PetalFieldHandle } from "./Petals.js";
import "./journey.css";

gsap.registerPlugin(useGSAP, ScrollTrigger);

/* Embedded previews can load the page with the document hidden, so rAF — and
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

  useGSAP(
    () => {
      const root = rootRef.current;
      const stage = stageRef.current;
      if (!root || !stage) throw new Error("The journey stage did not mount.");
      const q = gsap.utils.selector(stage);
      const reduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;

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
        const maxWidth =
          ((box.height * maxHeightFraction * CARD_RATIO) / box.width) * 100;
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
            left:
              source.feature.left + (source.feature.width - featureWidth) / 2,
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
      gsap.set(q(".sponsors__title"), { autoAlpha: 0, y: "36svh" });
      gsap.set(panels, { autoAlpha: 0, xPercent: 8 });
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
          {
            backgroundPositionX: `-=${distance}`,
            duration: 22,
            ease: "power2.out",
          },
          6,
        );
      pan(ridges.near, 1500);
      pan(ridges.mid, 920);
      pan(ridges.far, 520);

      tl.to(
        q(".hero-copy"),
        { xPercent: -178, autoAlpha: 0, duration: 7, ease: "power2.in" },
        6,
      ).to(
        q(".hero-tree"),
        { xPercent: -120, duration: 9, ease: "power2.in" },
        6,
      );

      /* C — the mark opens up. First the white rim and dark ground fade out,
         leaving only the five coloured wedges; the cards take those over on a
         frame where nothing is moving, so the hand-off cannot be seen. */
      tl.to(
        q(".emblem__shell"),
        { autoAlpha: 0, duration: 2.6, ease: "power2.inOut" },
        11.5,
      )
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
         flies down to the fan. If the morph and the flight overlapped, the
         still-morphing triangles would visibly shrink mid-unfold on a phone,
         where a fan card is far smaller than the mark; any resize happens on
         the way to the hand instead. */
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
         Each beat is 7s, so the last card is back in the hand at 68.6,
         before the drop at 70. */
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
        {
          yPercent: 175,
          autoAlpha: 0,
          duration: 6,
          stagger: 0.3,
          ease: "power2.in",
        },
        70,
      )
        .to(ridges.mid, { yPercent: 0, duration: 9, ease: "power2.out" }, 71)
        .to(q(".embers"), { autoAlpha: 0, duration: 5 }, 70)
        .to(q(".wind"), { autoAlpha: 1, duration: 4 }, 71);

      lanterns.forEach((lantern, index) => {
        const spec = lanternAt(index, phone());
        const entry = -(spec.x + spec.size + 8);
        gsap.set(lantern, {
          x: `${entry}vw`,
          y: `${spec.drop}vh`,
          autoAlpha: 0,
        });

        tl.to(lantern, { autoAlpha: 1, duration: 2 }, 72 + index * 1.6)
          /* Blown across — fast at first, then the gust lets go. */
          .to(
            lantern,
            { x: 0, duration: 20, ease: "power2.out" },
            72 + index * 1.6,
          )
          /* And rising all the while, easing out as it finds its level. */
          .to(
            lantern,
            { y: 0, duration: 24, ease: "sine.out" },
            72 + index * 1.6,
          );
      });

      tl.to(
        q(".lantern__label"),
        { autoAlpha: 1, duration: 3, stagger: 0.8 },
        86,
      );

      /* H — the wind takes the lanterns away while every ridge drops below
         the stage. The sponsor act begins only after the sky is fully clear. */
      tl.to(q(".lantern__label"), { autoAlpha: 0, duration: 2.5 }, 94)
        .to(q(".wind"), { autoAlpha: 0, duration: 4 }, 96)
        .to(
          lanterns,
          {
            x: "86vw",
            y: "-52vh",
            autoAlpha: 0,
            duration: 7,
            stagger: 0.5,
            ease: "power2.in",
          },
          95,
        );

      /* The hills stay through the sponsor volley — every shell launches from
         behind the front ridge — and only drop away with the last tier. */
      tl.to(
        [ridges.near, ridges.mid],
        { yPercent: 130, duration: 9, ease: "power2.inOut" },
        141,
      ).to(
        ridges.far,
        { yPercent: 130, duration: 9, ease: "power2.inOut" },
        142,
      );

      /* H2 — the title travels with the descending background and reaches the
         bottom of the cleared sky before the sponsor volley begins. Every
         firecracker phase is scrubbed by this timeline: stop the wheel and
         the shell stops; reverse it and the shell rewinds. */
      tl.to(
        q(".sponsors__title"),
        { autoAlpha: 1, y: 0, duration: 7, ease: "power3.out" },
        103,
      ).to(
        q(".sponsors__title"),
        { autoAlpha: 0, y: "18svh", duration: 8, ease: "power2.in" },
        142,
      );

      /* H3 — fade the sponsor sky into the footer background. */
      tl.to(
        q(".sky-dim"),
        { autoAlpha: 1, duration: 10, ease: "power1.inOut" },
        141,
      );

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
        } else {
          api.setMode("drift");
          api.setIntensity(0);
        }
      };

      /* The scroll timeline carries a weighted playhead over the master
         timeline, doubling the wheel distance for About and the sponsor
         reveals (see JOURNEY_SCROLL_SEGMENTS). */
      tl.pause(0);
      const playhead = { at: 0 };
      const syncMaster = () => tl.time(playhead.at);
      const scrollTimeline = gsap.timeline({
        paused: true,
        defaults: { ease: "none" },
      });
      JOURNEY_SCROLL_SEGMENTS.forEach((segment) => {
        scrollTimeline.to(playhead, {
          at: segment.to,
          duration: (segment.to - segment.from) * segment.distanceScale,
          onUpdate: syncMaster,
        });
      });

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
          sponsorCue(self.progress);
        },
        onRefresh: (self) => {
          petalCue(self.progress);
          sponsorCue(self.progress);
        },
      });

      const leap = (event: CustomEvent<JourneyLeapDetail>) => {
        const progress = event.detail.progress;
        trigger.getTween()?.pause();
        scrollTimeline.progress(progress);
        syncMaster();
        trigger.update();
        trigger.getTween()?.progress(1);
        scrollTimeline.progress(progress);
        syncMaster();
        petalCue(progress);
        sponsorCue(progress);
      };

      window.addEventListener(JOURNEY_LEAP_EVENT, leap);

      if (scrollTimeline.duration() !== JOURNEY_SCROLL_DURATION) {
        throw new Error(
          "The journey scroll timing does not match its segment map.",
        );
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
      const images = Array.from(
        stage.querySelectorAll<HTMLImageElement>("img"),
      );
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
        window.removeEventListener(JOURNEY_LEAP_EVENT, leap);
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
            <img
              key={index}
              src="/assets/img/lantern.png"
              alt=""
              style={emberStyle(ember)}
            />
          ))}
        </div>

        <div className="ridge ridge--mid" aria-hidden="true" />

        <Wind />
        <Lanterns stageRef={stageRef} />
        <Fireworks ref={fireworksRef} />
        <Cards />

        <div className="ridge ridge--near" aria-hidden="true" />

        <img
          className="hero-tree"
          src="/assets/img/tree.webp"
          alt=""
          aria-hidden="true"
        />

        {/* ---------- hero ---------- */}
        <div className="emblem-holder">
          <Emblem />
        </div>

        <div className="hero-copy">
          <h1 className="hero-wordmark">
            <img
              src="/assets/svg/wordmark.svg"
              alt="Code2Create"
              width="669"
              height="85"
            />
          </h1>
          <p className="hero-tagline">
            Don’t just code for the vibes, Code2Create.
          </p>
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
      </div>
    </div>
  );
}
