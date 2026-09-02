import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type OfficialLink = { label: string; href: string }

export function GuideMarkdown({
  text,
  officialLinks,
  tone = 'answer',
}: {
  text: string
  officialLinks: readonly OfficialLink[]
  /** `thinking` sets the model's own summary smaller and quieter than an answer. */
  tone?: 'answer' | 'thinking'
}) {
  const muted = tone === 'thinking'
  return (
    <div
      className={`guide-prose min-w-0 wrap-anywhere ${
        muted ? 'text-[12.5px] leading-relaxed text-fg/55' : 'text-[14.5px] leading-[1.7] text-fg/90'
      }`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mt-0 mb-3 last:mb-0">{children}</p>,
          h1: ({ children }) => <h2 className={`mt-4 mb-1.5 font-semibold first:mt-0 ${muted ? 'text-[12.5px] text-fg/70' : 'text-[14px] text-fg'}`}>{children}</h2>,
          h2: ({ children }) => <h2 className={`mt-4 mb-1.5 font-semibold first:mt-0 ${muted ? 'text-[12.5px] text-fg/70' : 'text-[14px] text-fg'}`}>{children}</h2>,
          h3: ({ children }) => <h3 className={`mt-3.5 mb-1.5 font-semibold first:mt-0 ${muted ? 'text-[12.5px] text-fg/70' : 'text-[13.5px] text-fg'}`}>{children}</h3>,
          ul: ({ children }) => <ul className="mt-0 mb-3 grid list-disc gap-1.5 pl-5 marker:text-rose-light">{children}</ul>,
          ol: ({ children }) => <ol className="mt-0 mb-3 grid list-decimal gap-1.5 pl-5 marker:text-rose-light">{children}</ol>,
          strong: ({ children }) => <strong className={`font-semibold ${muted ? 'text-fg/75' : 'text-fg'}`}>{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className="my-3 border-l-2 border-rose-light/70 pl-3.5 text-fg/65">{children}</blockquote>
          ),
          table: ({ children }) => (
            <table className="my-3 block w-full overflow-x-auto border-collapse text-[12px]">{children}</table>
          ),
          th: ({ children }) => (
            <th className="border border-petal-line bg-fg/5 px-2.5 py-1.5 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-petal-line px-2.5 py-1.5 text-left align-top">{children}</td>
          ),
          code: ({ children }) => (
            <code className="rounded-[6px] border border-petal-line bg-fg/5 px-1.5 py-0.5 font-mono text-[.84em]">{children}</code>
          ),
          a: ({ href, children }) => {
            const candidate = href ?? '/'
            const safeHref =
              candidate === '/' || candidate === '/integrations' || officialLinks.some((link) => link.href === candidate)
                ? candidate
                : '/'
            const external = safeHref.startsWith('https://')
            return (
              <a
                className="text-rose-light underline decoration-rose-light/50 underline-offset-[3px] transition-colors hover:decoration-rose-light"
                href={safeHref}
                {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
              >
                {children}
              </a>
            )
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
