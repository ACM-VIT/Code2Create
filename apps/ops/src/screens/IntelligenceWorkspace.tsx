import { useState } from 'react'

import { OperationsBrief } from '../components/OperationsBrief'
import { OperationsCopilotConsole } from '../components/OperationsCopilotConsole'
import { AgentControlPlane } from '../components/intelligence/AgentControlPlane'
import { IntelligenceActivity } from './IntelligenceActivity'

type IntelligenceTab = 'agents' | 'activity' | 'ask' | 'brief'

export function IntelligenceWorkspace({
  canGenerate,
  canRead,
  showBrief,
}: {
  canGenerate: boolean
  canRead: boolean
  showBrief: boolean
}) {
  const [tab, setTab] = useState<IntelligenceTab>(
    canRead ? 'agents' : showBrief ? 'brief' : 'ask',
  )
  let activeTab = tab
  if (tab === 'agents' && !canRead) activeTab = showBrief ? 'brief' : 'ask'
  if (tab === 'activity' && !canRead) activeTab = showBrief ? 'brief' : 'ask'
  if (tab === 'brief' && !showBrief) activeTab = 'ask'
  const tabs: { id: IntelligenceTab; label: string }[] = []
  if (canRead) {
    tabs.push({ id: 'agents', label: 'Agents' })
    tabs.push({ id: 'activity', label: 'Decisions' })
  }
  tabs.push({ id: 'ask', label: 'Ask' })
  if (showBrief) tabs.push({ id: 'brief', label: 'Summary' })

  return (
    <section className="intelligence-workspace flex min-h-0 flex-1 flex-col">
      <h1 className="visually-hidden">Operations agent</h1>
      <header className="flex shrink-0 items-center justify-between border-b border-line p-1.5">
        <div aria-label="Operations agent views" className="flex items-center gap-0.5" role="tablist">
          {tabs.map((entry) => (
            <button
              aria-selected={activeTab === entry.id}
              className={`cursor-pointer rounded-[6px] border-0 px-2 py-[3px] text-[13px] text-ink transition-[background-color,opacity] duration-100 ${
                activeTab === entry.id ? 'bg-field' : 'bg-transparent opacity-50 hover:opacity-75'
              }`}
              key={entry.id}
              onClick={() => setTab(entry.id)}
              role="tab"
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col" role="tabpanel">
        {activeTab === 'agents' ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
            <AgentControlPlane />
          </div>
        ) : activeTab === 'activity' ? (
          <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-5">
            <IntelligenceActivity canGenerate={canGenerate} />
          </div>
        ) : activeTab === 'ask' ? (
          <OperationsCopilotConsole canGenerate={canGenerate} canRead={canRead} />
        ) : (
          <div className="grid min-h-0 flex-1 content-start gap-5 overflow-y-auto p-5">
            <OperationsBrief canGenerate={canGenerate} canRead={canRead} />
          </div>
        )}
      </div>
    </section>
  )
}
