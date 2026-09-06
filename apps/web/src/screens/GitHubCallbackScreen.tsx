import { api } from "@code2create/backend/api";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import type { GitHubConnectionResult } from "../types";

const pendingCompletions = new Map<string, Promise<GitHubConnectionResult>>();

export function GitHubCallbackScreen() {
  const completeConnection = useAction(api.githubActions.completeConnection);
  const beginConnection = useAction(api.githubActions.beginConnection);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [completionFailure, setCompletionFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [selection, setSelection] = useState<Extract<
    GitHubConnectionResult,
    { kind: "choose_installation" }
  > | null>(null);
  const [starting, setStarting] = useState(false);
  const state = searchParams.get("state");
  const code = searchParams.get("code");
  const installationId = searchParams.get("installation_id");
  const parameterError =
    !state || !code
      ? "GitHub returned an incomplete connection. Start again from integrations."
      : null;
  const completionKey = `${state ?? ""}:${installationId ?? ""}`;
  const error =
    parameterError ?? (completionFailure?.key === completionKey ? completionFailure.message : null);

  useEffect(() => {
    if (!state || !code) return;
    const key = `${state}:${installationId ?? ""}`;
    let completion = pendingCompletions.get(key);
    if (!completion) {
      completion = completeConnection({
        eventSlug,
        state,
        code,
        ...(installationId ? { installationId } : {}),
      });
      pendingCompletions.set(key, completion);
      void completion.then(
        () => pendingCompletions.delete(key),
        () => pendingCompletions.delete(key),
      );
    }
    let active = true;
    void completion
      .then((result) => {
        if (!active) return;
        if (result.kind === "choose_installation") {
          setSelection(result);
        } else {
          void navigate(`/integrations?connectionId=${encodeURIComponent(result.connectionId)}`, {
            replace: true,
            viewTransition: true,
          });
        }
      })
      .catch((caught: unknown) => {
        if (active) {
          setCompletionFailure({ key: completionKey, message: readableError(caught) });
        }
      });
    return () => {
      active = false;
    };
  }, [code, completeConnection, completionKey, installationId, navigate, state]);

  async function choose(installationId?: string) {
    if (starting) return;
    setStarting(true);
    setCompletionFailure(null);
    try {
      const result = await beginConnection({
        eventSlug,
        ...(installationId ? { installationId } : { install: true }),
      });
      window.location.assign(result.installUrl);
    } catch (caught) {
      setCompletionFailure({ key: completionKey, message: readableError(caught) });
      setStarting(false);
    }
  }

  return (
    <section className="integration-shell narrow-panel">
      <p className="eyebrow">GitHub</p>
      <h1>{selection ? "Choose a GitHub account." : error ? "Connection failed." : "Connecting…"}</h1>
      {selection ? (
        <>
          <p className="lead">
            {selection.installations.length
              ? "Choose where your project lives. Next, select the repositories to share with your team."
              : "This GitHub account has no accessible Code2Create installation. Install the App on the account that owns your project."}
          </p>
          <div className="my-6 flex flex-col items-start gap-3" aria-busy={starting}>
            {selection.installations.map((installation) => (
              <button
                key={installation.installationId}
                type="button"
                className="secondary"
                disabled={starting}
                onClick={() => void choose(installation.installationId)}
              >
                Connect {installation.accountLogin}
              </button>
            ))}
            <button
              type="button"
              className="secondary"
              disabled={starting}
              onClick={() => void choose()}
            >
              Install on {selection.installations.length ? "another" : "your"} account
            </button>
          </div>
          {starting && (
            <p className="muted" role="status">Opening GitHub…</p>
          )}
          {error && <p role="alert">{error}</p>}
          <Link className="secondary link-button" to="/integrations" viewTransition>
            Back to integrations
          </Link>
        </>
      ) : error ? (
        <>
          <p className="lead">{error}</p>
          <Link className="secondary link-button" to="/integrations" viewTransition>
            Back to integrations
          </Link>
        </>
      ) : (
        <p className="muted" role="status">
          Verifying the installation with GitHub.
        </p>
      )}
    </section>
  );
}
