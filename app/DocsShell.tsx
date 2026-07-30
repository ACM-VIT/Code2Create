"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type DocumentItem = {
  slug: string;
  number: string;
  label: string;
  content: string;
};

type Heading = {
  level: number;
  text: string;
  id: string;
};

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function headingsFrom(markdown: string): Heading[] {
  return markdown
    .split("\n")
    .map((line) => {
      const match = /^(#{2,3})\s+(.+)$/.exec(line);
      if (!match) return null;
      const text = match[2].replace(/[*_`]/g, "").trim();
      return { level: match[1].length, text, id: slugify(text) };
    })
    .filter((heading): heading is Heading => Boolean(heading));
}

function plainText(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`|[\]()~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function DocsShell({ documents }: { documents: DocumentItem[] }) {
  const [activeSlug, setActiveSlug] = useState(documents[0].slug);
  const [query, setQuery] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const requested = window.location.hash.slice(1);
    if (documents.some((doc) => doc.slug === requested)) {
      setActiveSlug(requested);
    }
  }, [documents]);

  const active =
    documents.find((document) => document.slug === activeSlug) ?? documents[0];
  const headings = useMemo(() => headingsFrom(active.content), [active.content]);

  const results = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized.length < 2) return [];

    return documents
      .map((document) => {
        const text = plainText(document.content);
        const index = text.toLowerCase().indexOf(normalized);
        if (index < 0) return null;
        const start = Math.max(0, index - 70);
        const end = Math.min(text.length, index + normalized.length + 110);
        return {
          document,
          snippet: `${start > 0 ? "…" : ""}${text.slice(start, end)}${
            end < text.length ? "…" : ""
          }`,
        };
      })
      .filter(
        (
          result,
        ): result is { document: DocumentItem; snippet: string } =>
          Boolean(result),
      )
      .slice(0, 8);
  }, [documents, query]);

  function chooseDocument(slug: string) {
    setActiveSlug(slug);
    setMenuOpen(false);
    setQuery("");
    window.history.replaceState(null, "", `#${slug}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return (
    <div className="docs-app">
      <header className="topbar">
        <button
          className="menu-button"
          type="button"
          aria-label="Toggle document navigation"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((value) => !value)}
        >
          <span />
          <span />
        </button>
        <a className="brand" href="#index" onClick={() => chooseDocument("index")}>
          <span className="brand-mark">C2C</span>
          <span className="brand-copy">
            <strong>Platform specifications</strong>
            <small>Working handbook · 7.0</small>
          </span>
        </a>
        <div className="topbar-actions">
          <span className="status-pill">
            <i />
            Internal
          </span>
          <a className="sign-out" href="/api/logout">
            Lock
          </a>
        </div>
      </header>

      <aside className={`sidebar ${menuOpen ? "is-open" : ""}`}>
        <div className="search-wrap">
          <label htmlFor="docs-search">Search the handbook</label>
          <div className="search-input">
            <span aria-hidden="true">⌕</span>
            <input
              id="docs-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Try “override”"
              autoComplete="off"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                ×
              </button>
            )}
          </div>
          {query.trim().length >= 2 && (
            <div className="search-results" aria-live="polite">
              <p>{results.length ? `${results.length} matches` : "No matches"}</p>
              {results.map(({ document, snippet }) => (
                <button
                  key={document.slug}
                  type="button"
                  onClick={() => chooseDocument(document.slug)}
                >
                  <strong>{document.label}</strong>
                  <span>{snippet}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <nav className="document-nav" aria-label="Specification documents">
          <p>Documents</p>
          {documents.map((document) => (
            <button
              type="button"
              key={document.slug}
              className={document.slug === active.slug ? "active" : ""}
              aria-current={document.slug === active.slug ? "page" : undefined}
              onClick={() => chooseDocument(document.slug)}
            >
              <span>{document.number}</span>
              {document.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-note">
          <span>Source of truth</span>
          <p>Rendered directly from the Markdown specifications.</p>
        </div>
      </aside>

      <main className="document-stage">
        <article className="markdown-body">
          <div className="document-kicker">
            <span>Code2Create 7.0</span>
            <span>Document {active.number}</span>
          </div>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => <h1>{children}</h1>,
              h2: ({ children }) => {
                const text = String(children);
                return <h2 id={slugify(text)}>{children}</h2>;
              },
              h3: ({ children }) => {
                const text = String(children);
                return <h3 id={slugify(text)}>{children}</h3>;
              },
              a: ({ href, children }) => {
                const markdownLink = href?.endsWith(".md");
                if (!markdownLink) return <a href={href}>{children}</a>;
                const matched = documents.find((doc) =>
                  doc.content
                    .split("\n")[0]
                    .toLowerCase()
                    .includes(String(children).toLowerCase()),
                );
                return (
                  <button
                    className="inline-doc-link"
                    type="button"
                    onClick={() => matched && chooseDocument(matched.slug)}
                  >
                    {children}
                  </button>
                );
              },
            }}
          >
            {active.content}
          </ReactMarkdown>
          <footer className="document-footer">
            <span>End of document {active.number}</span>
            <button
              type="button"
              onClick={() => {
                const index = documents.findIndex(
                  (document) => document.slug === active.slug,
                );
                chooseDocument(documents[(index + 1) % documents.length].slug);
              }}
            >
              Next document <b>→</b>
            </button>
          </footer>
        </article>
      </main>

      <aside className="toc">
        <p>On this page</p>
        <nav aria-label="On this page">
          {headings.map((heading) => (
            <a
              className={heading.level === 3 ? "nested" : ""}
              key={`${heading.id}-${heading.text}`}
              href={`#${heading.id}`}
            >
              {heading.text}
            </a>
          ))}
        </nav>
      </aside>

      {menuOpen && (
        <button
          type="button"
          className="sidebar-scrim"
          aria-label="Close document navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}
    </div>
  );
}
