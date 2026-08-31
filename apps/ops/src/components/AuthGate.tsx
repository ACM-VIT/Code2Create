import type { ReactNode } from 'react'

import { AcmMark, BrandBackdrop, BrandMark, BrandWordmark } from './Brand'

export function Gate({
  children,
  error,
  subtitle,
  title,
  who,
}: {
  children: ReactNode
  error?: string | null
  subtitle?: string
  title: string
  who?: string
}) {
  return (
    <BrandBackdrop>
      <main className="gate">
        <div className="gate-body">
          <BrandMark size={104} />
          <div className="gate-wordmark">
            <BrandWordmark width={228} />
          </div>
          <h1 className="gate-title">{title}</h1>
          {subtitle ? <p className="gate-subtitle">{subtitle}</p> : null}
          {who ? <p className="gate-who">{who}</p> : null}
        </div>
        {error ? (
          <p className="gate-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="gate-actions">{children}</div>
      </main>
      <div className="gate-foot">
        <AcmMark size={40} />
      </div>
    </BrandBackdrop>
  )
}

export function GateAction({
  disabled = false,
  label,
  onClick,
  secondary = false,
}: {
  disabled?: boolean
  label: string
  onClick?: () => void
  secondary?: boolean
}) {
  return (
    <button
      className={secondary ? 'gate-action gate-action-secondary' : 'gate-action'}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  )
}

export function GateBoot({ status }: { status: string }) {
  return (
    <BrandBackdrop>
      <main className="gate gate-booting">
        <div className="gate-boot-mark">
          <BrandMark size={112} />
        </div>
        <div className="gate-boot-wordmark">
          <BrandWordmark width={252} />
        </div>
        <p className="visually-hidden" role="status">
          {status}
        </p>
      </main>
      <div className="gate-foot">
        <AcmMark size={40} />
      </div>
    </BrandBackdrop>
  )
}
