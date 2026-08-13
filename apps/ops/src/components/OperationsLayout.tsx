import { Link, NavLink } from 'react-router-dom'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import type { ReactNode } from 'react'

import { Icon, type IconName } from './Icon'
import { IncidentBanner } from './IncidentBanner'

export function OperationsLayout({
  accountEmail,
  authClient,
  identity,
  navigation,
  nowItems,
  stageLabel,
  children,
}: {
  accountEmail: string
  authClient: Code2CreateAuthClient
  identity: string
  navigation: OperationsNavigationGroup[]
  nowItems: OperationsNavigationItem[]
  stageLabel: string
  children: ReactNode
}) {
  return (
    <div
      className="operations-shell"
      data-account-email={accountEmail}
      data-app-surface="operations"
    >
      <aside className="sidebar">
        <Link className="sidebar-wordmark" to="/">Code2Create</Link>
        <nav aria-label="Operations">
          {nowItems.length > 0 ? (
            <section className="navigation-group" key="now">
              <p>{stageLabel}</p>
              {nowItems.map((item) => (
                <NavLink end={item.to === '/'} key={item.to} to={item.to}>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </section>
          ) : null}
          {navigation.length > 0 ? (
            <details className="navigation-rest">
              <summary>Everything else</summary>
              {navigation.map((group) => (
                <section className="navigation-group" key={group.label}>
                  <p>{group.label}</p>
                  {group.items.map((item) => (
                    <NavLink end={item.to === '/'} key={item.to} to={item.to}>
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </NavLink>
                  ))}
                </section>
              ))}
            </details>
          ) : null}
        </nav>
        <div className="sidebar-identity">
          <span title={accountEmail}>{identity}</span>
          <button className="text-button" type="button" onClick={() => void authClient.signOut()}>
            Sign out
          </button>
        </div>
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

export type OperationsNavigationItem = {
  label: string
  to: string
  icon: IconName
}
