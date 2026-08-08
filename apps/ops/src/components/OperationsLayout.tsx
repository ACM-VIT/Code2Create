import { Link, NavLink } from 'react-router-dom'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import type { ReactNode } from 'react'

import { IncidentBanner } from './IncidentBanner'

export function OperationsLayout({
  accountEmail,
  authClient,
  identity,
  navigation,
  children,
}: {
  accountEmail: string
  authClient: Code2CreateAuthClient
  identity: string
  navigation: OperationsNavigationGroup[]
  children: ReactNode
}) {
  return (
    <div
      className="operations-shell"
      data-account-email={accountEmail}
      data-app-surface="operations"
    >
      <header className="topbar">
        <Link className="wordmark" to="/">Code2Create</Link>
        <div className="identity">
          <span>{identity}</span>
          <button className="text-button" type="button" onClick={() => void authClient.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <aside className="sidebar">
        <nav aria-label="Operations">
          {navigation.map((group) => (
            <section className="navigation-group" key={group.label}>
              <p>{group.label}</p>
              {group.items.map((item) => (
                <NavLink end={item.to === '/'} key={item.to} to={item.to}>{item.label}</NavLink>
              ))}
            </section>
          ))}
        </nav>
      </aside>
      <main className="workspace">
        <IncidentBanner />
        {children}
      </main>
    </div>
  )
}

export type OperationsNavigationGroup = {
  label: string
  items: OperationsNavigationItem[]
}

type OperationsNavigationItem = {
  label: string
  to: string
}
