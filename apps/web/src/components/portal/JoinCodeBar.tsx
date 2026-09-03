import { useState } from "react";

function SwapLabel({ current, labels }: { current: string; labels: readonly string[] }) {
  return (
    <span className="grid text-center">
      {labels.map((label) => (
        <span
          key={label}
          aria-hidden={label !== current}
          className={`col-start-1 row-start-1 ${label === current ? "" : "invisible"}`}
        >
          {label}
        </span>
      ))}
    </span>
  );
}

export function JoinCodeBar({ code, className = "" }: { code: string; className?: string }) {
  const [copied, setCopied] = useState<"code" | "link" | "unavailable" | null>(null);
  const joinLink = `${window.location.origin}/join/${code}`;

  const copy = async (value: string, which: "code" | "link") => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
    } catch {
      setCopied("unavailable");
    }
    window.setTimeout(() => setCopied(null), 1800);
  };

  return (
    <div
      className={`inline-flex items-center gap-3.5 rounded-btn border-[1.5px] border-rose px-5 py-[15px] lg:gap-4 lg:px-6 ${className}`}
    >
      <span className="whitespace-nowrap font-mono text-[16px] tracking-[.14em] text-rose-light lg:text-[17px]">
        {code}
      </span>
      <span aria-hidden className="h-[18px] w-px bg-rose/50" />
      <button
        type="button"
        onClick={() => void copy(code, "code")}
        className="text-[13.5px] font-semibold text-fg/85 transition-colors hover:text-rose-light"
      >
        <SwapLabel
          current={copied === "code" ? "copied" : copied === "unavailable" ? "unavailable" : "copy"}
          labels={["copy", "copied", "unavailable"]}
        />
      </button>
      <button
        type="button"
        onClick={() => void copy(joinLink, "link")}
        className="whitespace-nowrap text-[13.5px] font-semibold text-fg/85 transition-colors hover:text-rose-light"
      >
        <SwapLabel
          current={copied === "link" ? "copied" : "share link"}
          labels={["share link", "copied"]}
        />
      </button>
    </div>
  );
}
