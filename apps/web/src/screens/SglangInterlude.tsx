import { DaybreakToggle } from '../components/portal/DaybreakToggle'
import { Petals } from '../components/portal/Petals'

/**
 * Mockup fs: a quiet note between review and confirm asking the team to
 * look at SGLang. Off the painted scene, but not off the world: a soft
 * light gradient and a few drifting petals keep it in the garden. Shown
 * once per browser; both paths continue to the confirm screen.
 */
export function SglangInterlude({ onContinue }: { onContinue: () => void }) {
  return (
    <div
      data-portal-scene
      className="relative flex min-h-dvh flex-col items-center overflow-hidden bg-wash bg-[image:var(--note-bg)] px-5 font-ui text-fg"
    >
      <Petals className="opacity-25" />
      <img
        src="/assets/logo.svg"
        alt="Code2Create"
        className="absolute top-9 left-6 w-[26px] drop-shadow-[0_0_14px_var(--logo-glow)] lg:left-11 lg:w-[30px]"
      />
      <div className="absolute top-9 right-6 lg:right-11">
        <DaybreakToggle />
      </div>
      <div className="relative mx-auto flex w-full max-w-[660px] flex-1 flex-col justify-center pt-16 pb-14 text-center">
        <h1 className="mb-6 font-display font-light tracking-[-.01em] text-balance text-[28px] leading-[1.25] lg:text-[38px]">
          We’d love for you to star SGLang.
        </h1>
        <p className="m-0 text-pretty text-[15px] leading-[1.8] text-fg/70">
          It serves trillions of tokens a day across 400,000+ GPUs, at xAI, NVIDIA, AMD, LinkedIn,
          and Cursor. ACM-VIT contributes to it, and our alum{' '}
          <a
            href="https://github.com/adarshxs"
            target="_blank"
            rel="noreferrer"
            className="text-rose-light underline underline-offset-[3px]"
          >
            Adarsh Shriwalmath ↗
          </a>{' '}
          went from contributor to maintainer to MLE at Hugging Face.
        </p>
        <p className="mt-4 mb-0 text-pretty text-[15px] leading-[1.8] text-fg/70">
          No obligation. We just want you to look inside and get into inference.
        </p>

        <div className="mt-[38px] flex flex-col items-center gap-3.5">
          <a
            href="https://github.com/sgl-project/sglang"
            target="_blank"
            rel="noreferrer"
            onClick={onContinue}
            className="inline-flex items-center justify-center rounded-btn border-[1.5px] border-rose bg-transparent px-[34px] py-3 text-sm font-semibold text-rose-light transition-[background,color] duration-250 hover:bg-rose hover:text-wash"
          >
            Star sgl-project/sglang
          </a>
          <button
            type="button"
            onClick={onContinue}
            className="text-[13px] text-fg/55 transition-colors hover:text-fg"
          >
            maybe later
          </button>
        </div>

        <div className="mt-[54px] flex items-center justify-center gap-[26px] opacity-55">
          <span className="inline-flex items-center gap-[7px]">
            <img src="/assets/sglang-logo.png" alt="" className="w-5" />
            <span className="text-sm font-bold">SGLang</span>
          </span>
          <span aria-hidden className="h-3.5 w-px bg-fg/30" />
          <span className="inline-flex items-center gap-[7px]">
            <img src="/assets/lmsys-logo.svg" alt="" className="w-[17px] [filter:var(--mark-filter)]" />
            <span className="text-sm font-semibold tracking-[.1em]">LMSYS</span>
          </span>
          <span aria-hidden className="h-3.5 w-px bg-fg/30" />
          <span className="inline-flex items-center gap-1.5">
            <img src="/assets/logo.svg" alt="" className="w-[15px]" />
            <span className="text-sm font-semibold tracking-[.06em]">ACM-VIT</span>
          </span>
        </div>
      </div>
    </div>
  )
}
