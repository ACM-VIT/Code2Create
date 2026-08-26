import { Link, NavLink, useLocation } from 'react-router-dom'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import { useEffect, useState, type ReactNode } from 'react'

import { Icon, type IconName } from './Icon'
import { IncidentBanner } from './IncidentBanner'
import { FreshAuthenticationPrompt } from './FreshAuthenticationPrompt'

export function OperationsLayout({
  accountEmail,
  authClient,
  homePath,
  identity,
  navigation,
  nowItems,
  showIncidents,
  stageLabel,
  children,
}: {
  accountEmail: string
  authClient: Code2CreateAuthClient
  homePath: string
  identity: string
  navigation: OperationsNavigationGroup[]
  nowItems: OperationsNavigationItem[]
  showIncidents: boolean
  stageLabel: string
  children: ReactNode
}) {
  const location = useLocation()
  const activeToolIsInDisclosure = navigation.some((group) => group.items.some((item) => (
    location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)
  )))
  const [toolsOpen, setToolsOpen] = useState(activeToolIsInDisclosure)
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false)
  const activeItem = [...nowItems, ...navigation.flatMap((group) => group.items)].find((item) => (
    location.pathname === item.to || location.pathname.startsWith(`${item.to}/`)
  ))

  useEffect(() => {
    if (activeToolIsInDisclosure) setToolsOpen(true)
  }, [activeToolIsInDisclosure])

  useEffect(() => {
    setMobileNavigationOpen(false)
  }, [location.pathname])

  return (
    <div
      className="operations-shell"
      data-account-email={accountEmail}
      data-app-surface="operations"
    >
      <FreshAuthenticationPrompt authClient={authClient} />
      <aside className="sidebar">
        <Link className="sidebar-wordmark" to={homePath}>Code2Create</Link>
        <nav aria-label="Operations" className="desktop-navigation">
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
            <details
              className="navigation-rest"
              open={toolsOpen}
              onToggle={(event) => setToolsOpen(event.currentTarget.open)}
            >
              <summary>All workspaces</summary>
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
        <nav aria-label="Operations" className="mobile-navigation">
          <details
            open={mobileNavigationOpen}
            onToggle={(event) => setMobileNavigationOpen(event.currentTarget.open)}
          >
            <summary>
              <span>{activeItem?.label ?? 'Workspaces'}</span>
              <small>Switch workspace</small>
            </summary>
            <div className="mobile-navigation-menu">
              {nowItems.length > 0 ? (
                <section className="navigation-group">
                  <p>{stageLabel}</p>
                  {nowItems.map((item) => (
                    <NavLink end={item.to === '/'} key={item.to} to={item.to}>
                      <Icon name={item.icon} />
                      <span>{item.label}</span>
                    </NavLink>
                  ))}
                </section>
              ) : null}
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
            </div>
          </details>
        </nav>
        <div className="sidebar-identity">
          <span title={accountEmail}>{identity}</span>
          <button className="text-button" type="button" onClick={() => void authClient.signOut()}>
            Sign out
          </button>
        </div>
      </aside>
      <main className="workspace">
        {showIncidents ? <IncidentBanner /> : null}
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
