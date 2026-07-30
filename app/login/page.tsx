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
          <div className="login-mark">Code2Create 7.0</div>
          <span>Working handbook</span>
        </div>
        <div className="login-copy">
          <h1>Platform specifications</h1>
          <p>
            Product decisions, review rules, participant flows, and launch
            requirements for the organising team.
          </p>
        </div>
        <form className="login-form" action="/api/login" method="post">
          <label htmlFor="password">Shared password</label>
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
              Open <span>→</span>
            </button>
          </div>
          {error && (
            <p id="login-error" className="login-error" role="alert">
              That password didn’t match. Try again.
            </p>
          )}
        </form>
      </section>
    </main>
  );
}
