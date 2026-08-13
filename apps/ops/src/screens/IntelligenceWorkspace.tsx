import { OperationsBrief } from '../components/OperationsBrief'
import { OperationsCopilotConsole } from '../components/OperationsCopilotConsole'
import { IntelligenceActivity } from './IntelligenceActivity'

export function IntelligenceWorkspace({
  canGenerate,
  canRead,
}: {
  canGenerate: boolean
  canRead: boolean
}) {
  return (
    <section className="intelligence-workspace-shell">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Operations</p>
          <h1>Intelligence</h1>
          <p className="muted">Monitor effect-bounded autonomous work, ask the copilot, and inspect manual briefs.</p>
        </div>
      </header>

      <OperationsCopilotConsole canGenerate={canGenerate} canRead={canRead} />
      <OperationsBrief canGenerate={canGenerate} canRead={canRead} />
      {canRead ? <IntelligenceActivity canGenerate={canGenerate} /> : null}
    </section>
  )
}
