import { api } from '@code2create/backend/api'
import type { Code2CreateAuthClient } from '@code2create/web-auth'
import {
  AuthLoading,
  Authenticated,
  Unauthenticated,
  useAction,
  useQuery,
} from 'convex/react'
import { lazy, Suspense, useDeferredValue, useState } from 'react'
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom'

import { eventSlug } from './lib/config'
import './App.css'

const MarkdownDocument = lazy(() =>
  import('./MarkdownDocument').then((module) => ({ default: module.MarkdownDocument })),
)

type HandbookDocument = {
  slug: string
  title: string
  sourcePath: string
  order: number
}

export default function App({ authClient }: { authClient: Code2CreateAuthClient }) {
  const publicState = useQuery(api.system.getPublicShellState, { eventSlug })

  if (publicState === undefined) return <Centered>Loading…</Centered>

  return (
    <>
      <AuthLoading>
        <Centered>Checking access…</Centered>
      </AuthLoading>
      <Unauthenticated>
        <SignIn
          authClient={authClient}
          eventName={publicState.event?.name ?? 'Code2Create'}
          googleConfigured={publicState.auth.googleConfigured}
          localDevelopmentFixturesEnabled={publicState.auth.localDevelopmentFixturesEnabled}
        />
      </Unauthenticated>
      <Authenticated>
        <ProtectedHandbook authClient={authClient} />
      </Authenticated>
    </>
  )
}

function ProtectedHandbook({ authClient }: { authClient: Code2CreateAuthClient }) {
  const access = useQuery(api.access.handbookCapabilities, { eventSlug })
  const { data: session } = authClient.useSession()

  if (access === undefined) return <Centered>Loading your handbook access…</Centered>
  if (!access?.read) {
    return (
      <main className="centered">
        <section className="access-message">
          <p className="eyebrow">Code2Create handbook</p>
          <h1>No handbook access</h1>
          <p className="muted">This Google account has not been granted permission to read the internal handbook.</p>
          <button className="secondary" type="button" onClick={() => void authClient.signOut()}>
            Sign out
          </button>
        </section>
      </main>
    )
  }

  return (
    <Handbook
      authClient={authClient}
      identity={session?.user.name || session?.user.email || 'Signed in'}
    />
  )
}

function Handbook({
  authClient,
  identity,
}: {
  authClient: Code2CreateAuthClient
  identity: string
}) {
  const documents = useQuery(api.handbook.list, { eventSlug })
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search.trim())
  const searchResults = useQuery(
    api.handbook.search,
    deferredSearch.length >= 2 && deferredSearch.length <= 80
      ? { eventSlug, query: deferredSearch }
      : 'skip',
  )
  const navigate = useNavigate()

  if (documents === undefined) return <Centered>Loading the handbook…</Centered>
  if (documents.length === 0) return <Centered>The handbook has no documents.</Centered>

  const firstDocument = documents[0]
  if (!firstDocument) return <Centered>The handbook has no documents.</Centered>

  return (
    <div className="handbook-shell" data-app-surface="handbook">
      <header className="handbook-header">
        <NavLink className="wordmark" to={`/docs/${firstDocument.slug}`}>
          Code2Create handbook
        </NavLink>
        <div className="header-actions">
          <span className="identity">{identity}</span>
          <button className="text-button" type="button" onClick={() => void authClient.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      <aside className="document-sidebar">
        <SearchBox
          query={search}
          results={searchResults}
          onChange={setSearch}
          onChoose={(slug) => {
            setSearch('')
            navigate(`/docs/${slug}`)
          }}
        />
        <nav className="document-nav" aria-label="Handbook documents">
          {documents.map((document) => (
            <NavLink key={document.slug} to={`/docs/${document.slug}`}>
              <span>{String(document.order).padStart(2, '0')}</span>
              {document.title}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="document-workspace">
        <Routes>
          <Route path="/" element={<Navigate replace to={`/docs/${firstDocument.slug}`} />} />
          <Route
            path="/docs/:documentSlug"
            element={<DocumentView documents={documents} />}
          />
          <Route path="*" element={<NotFound firstDocument={firstDocument} />} />
        </Routes>
      </main>
    </div>
  )
}

function SearchBox({
  query,
  results,
  onChange,
  onChoose,
}: {
  query: string
  results: Array<{ slug: string; title: string; sourcePath: string; snippet: string }> | undefined
  onChange: (query: string) => void
  onChoose: (slug: string) => void
}) {
  const active = query.trim().length >= 2

  return (
    <div className="search-area">
      <label htmlFor="handbook-search">Search</label>
      <input
        id="handbook-search"
        type="search"
        value={query}
        maxLength={80}
        placeholder="Find a word or phrase"
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
      />
      {active ? (
        <div className="search-results" aria-live="polite">
          {results === undefined ? <p>Searching…</p> : null}
          {results?.length === 0 ? <p>No matches.</p> : null}
          {results?.map((result) => (
            <button key={result.slug} type="button" onClick={() => onChoose(result.slug)}>
              <strong>{result.title}</strong>
              <span>{result.snippet}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function DocumentView({ documents }: { documents: HandbookDocument[] }) {
  const { documentSlug } = useParams<{ documentSlug: string }>()
  const document = useQuery(
    api.handbook.document,
    documentSlug ? { eventSlug, slug: documentSlug } : 'skip',
  )

  if (document === undefined) return <p className="document-status">Loading document…</p>
  if (document === null) return <NotFound firstDocument={documents[0]} />

  const documentIndex = documents.findIndex((candidate) => candidate.slug === document.slug)
  const previousDocument = documentIndex > 0 ? documents[documentIndex - 1] : undefined
  const nextDocument = documentIndex >= 0 ? documents[documentIndex + 1] : undefined

  return (
    <article className="document-page">
      <header className="document-heading">
        <p className="document-number">Document {String(document.order).padStart(2, '0')}</p>
        <h1>{document.title}</h1>
        <p className="source-path">{document.sourcePath}</p>
      </header>
      <div className="markdown-body">
        <Suspense fallback={<p className="document-status" role="status">Rendering document…</p>}>
          <MarkdownDocument markdown={document.markdown} />
        </Suspense>
      </div>
      <nav className="document-pager" aria-label="Adjacent documents">
        {previousDocument ? (
          <NavLink to={`/docs/${previousDocument.slug}`}>
            <span>Previous</span>
            {previousDocument.title}
          </NavLink>
        ) : <span />}
        {nextDocument ? (
          <NavLink className="next" to={`/docs/${nextDocument.slug}`}>
            <span>Next</span>
            {nextDocument.title}
          </NavLink>
        ) : null}
      </nav>
    </article>
  )
}

function NotFound({ firstDocument }: { firstDocument: HandbookDocument | undefined }) {
  return (
    <section className="document-status">
      <h1>Document not found</h1>
      {firstDocument ? <NavLink to={`/docs/${firstDocument.slug}`}>Open the handbook</NavLink> : null}
    </section>
  )
}

function SignIn({
  authClient,
  eventName,
  googleConfigured,
  localDevelopmentFixturesEnabled,
}: {
  authClient: Code2CreateAuthClient
  eventName: string
  googleConfigured: boolean
  localDevelopmentFixturesEnabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createBrowserSession = useAction(api.localDevelopment.createBrowserSession)

  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await authClient.signIn.social({
        provider: 'google',
        callbackURL: window.location.href,
      })
      if (result.error) {
        setError(result.error.message || 'Google sign-in could not be completed.')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Google sign-in could not be completed.')
    } finally {
      setBusy(false)
    }
  }

  const signInLocally = async () => {
    setBusy(true)
    setError(null)
    try {
      const session = await createBrowserSession({
        confirmation: 'create-code2create-local-browser-session',
        actor: 'supreme',
        surface: 'handbook',
        returnPath: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      })
      window.location.assign(session.url)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Local sign-in could not be completed.')
      setBusy(false)
    }
  }

  return (
    <main className="centered">
      <section className="sign-in">
        <p className="eyebrow">Internal handbook</p>
        <h1>{eventName}</h1>
        <p className="muted">Sign in with the Google account that has been granted handbook access.</p>
        <button className="primary" type="button" disabled={!googleConfigured || busy} onClick={() => void signIn()}>
          {busy ? 'Opening Google…' : 'Continue with Google'}
        </button>
        {localDevelopmentFixturesEnabled ? (
          <button className="secondary" type="button" disabled={busy} onClick={() => void signInLocally()}>
            {busy ? 'Opening…' : 'Use local Supreme account'}
          </button>
        ) : null}
        {!googleConfigured && !localDevelopmentFixturesEnabled ? (
          <p className="notice">Google sign-in is unavailable. Ask an organizer to check handbook access.</p>
        ) : null}
        {error ? <p className="notice error" role="alert">{error}</p> : null}
      </section>
    </main>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <main className="centered"><p className="muted" role="status">{children}</p></main>
}
