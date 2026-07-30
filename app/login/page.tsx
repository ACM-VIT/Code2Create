import { redirect } from "next/navigation";
import { isAuthenticated } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await isAuthenticated()) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="login-page">
      <div className="login-grid" aria-hidden="true" />
      <section className="login-card">
        <div className="login-header">
          <div className="login-mark">C2C</div>
          <span>Internal handbook · 7.0</span>
        </div>
        <div className="login-copy">
          <p className="eyebrow">Restricted working document</p>
          <h1>The operating system for Code2Create.</h1>
          <p>
            Product decisions, review mechanics, participant flows, and launch
            standards—kept in one place for the organising team.
          </p>
        </div>
        <form className="login-form" action="/api/login" method="post">
          <label htmlFor="password">Shared access password</label>
          <div className="password-field">
            <input
              id="password"
              name="password"
              type="password"
              required
              autoFocus
              autoComplete="current-password"
              aria-describedby={error ? "login-error" : undefined}
            />
            <button type="submit">
              Unlock <span>→</span>
            </button>
          </div>
          {error && (
            <p id="login-error" className="login-error" role="alert">
              That password didn’t match. Try again.
            </p>
          )}
        </form>
        <footer>
          <span>ACM-VIT</span>
          <span>Private · 2026</span>
        </footer>
      </section>
      <aside className="login-index" aria-hidden="true">
        <span>01</span>
        <p>Plan deliberately.</p>
        <span>02</span>
        <p>Review fairly.</p>
        <span>03</span>
        <p>Operate visibly.</p>
      </aside>
    </main>
  );
}
