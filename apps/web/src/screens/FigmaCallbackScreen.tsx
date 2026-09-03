import { api } from "@code2create/backend/api";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import type { FigmaConnectionResult } from "../types";

const pendingCompletions = new Map<string, Promise<FigmaConnectionResult>>();

export function FigmaCallbackScreen() {
  const completeConnection = useAction(api.figmaActions.completeConnection);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [completionFailure, setCompletionFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const state = searchParams.get("state");
  const code = searchParams.get("code");
  const parameterError =
    !state || !code
      ? "Figma returned an incomplete connection. Start again from integrations."
      : null;
  const completionKey = state ?? "";
  const error =
    parameterError ?? (completionFailure?.key === completionKey ? completionFailure.message : null);

  useEffect(() => {
    if (!state || !code) return;
    let completion = pendingCompletions.get(state);
    if (!completion) {
      completion = completeConnection({ eventSlug, state, code });
      pendingCompletions.set(state, completion);
      void completion.then(
        () => pendingCompletions.delete(state),
        () => pendingCompletions.delete(state),
      );
    }
    let active = true;
    void completion
      .then(() => {
        if (active) void navigate("/integrations", { replace: true, viewTransition: true });
      })
      .catch((caught: unknown) => {
        if (active) {
          setCompletionFailure({ key: completionKey, message: readableError(caught) });
        }
      });
    return () => {
      active = false;
    };
  }, [code, completeConnection, completionKey, navigate, state]);

  return (
    <section className="integration-shell narrow-panel">
      <p className="eyebrow">Figma</p>
      <h1>{error ? "Connection failed." : "Connecting…"}</h1>
      {error ? (
        <>
          <p className="lead">{error}</p>
          <Link className="secondary link-button" to="/integrations" viewTransition>
            Back to integrations
          </Link>
        </>
      ) : (
        <p className="muted" role="status">
          Exchanging the short-lived Figma authorization.
        </p>
      )}
    </section>
  );
}
