import { api } from "@code2create/backend/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";
import { ErrorNotice } from "./Form";

type ReviewLinks = NonNullable<FunctionReturnType<typeof api.reviewLinks.current>>;
type ReviewLink = ReviewLinks["github"][number];
type ReviewOperationResult =
  | FunctionReturnType<typeof api.reviewLinks.addGithub>
  | FunctionReturnType<typeof api.reviewLinks.addFigma>
  | FunctionReturnType<typeof api.reviewLinks.archive>;

export function ReviewLinksPanel() {
  const links = useQuery(api.reviewLinks.current, { eventSlug });
  const addGithub = useMutation(api.reviewLinks.addGithub);
  const addFigma = useMutation(api.reviewLinks.addFigma);
  const archiveLink = useMutation(api.reviewLinks.archive);
  const [githubUrl, setGithubUrl] = useState("");
  const [figmaUrl, setFigmaUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const operations = useOperationRunner<ReviewOperationResult>();

  if (links === undefined) {
    return (
      <p className="muted" role="status">
        Loading review links…
      </p>
    );
  }
  if (!links) return null;

  const submitGithub = async () => {
    setBusy("github");
    setError(null);
    try {
      await operations.run(
        "review-link-github",
        (clientOperationId) => () =>
          addGithub({ eventSlug, repositoryUrl: githubUrl, clientOperationId }),
      );
      setGithubUrl("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const submitFigma = async () => {
    setBusy("figma");
    setError(null);
    try {
      await operations.run(
        "review-link-figma",
        (clientOperationId) => () =>
          addFigma({ eventSlug, fileUrl: figmaUrl, clientOperationId }),
      );
      setFigmaUrl("");
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (link: ReviewLink) => {
    setBusy(link.id);
    setError(null);
    try {
      await operations.run(
        `review-link-archive:${link.id}`,
        (clientOperationId) => () =>
          archiveLink({
            eventSlug,
            linkId: link.id,
            expectedVersion: link.version,
            clientOperationId,
          }),
      );
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="provider-section" aria-labelledby="review-links-heading">
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">For review</p>
          <h2 id="review-links-heading">GitHub and Figma links</h2>
          <p className="muted">
            Paste the repository and design file judges should open. Connecting GitHub or Figma is
            optional.
          </p>
        </div>
      </div>

      {links.canSubmit ? (
        <div className="repository-form compact-form">
          <label className="field form-span">
            <span className="field-label">GitHub repository link</span>
            <input
              value={githubUrl}
              disabled={busy !== null}
              maxLength={2048}
              placeholder="https://github.com/owner/repository"
              onChange={(event) => setGithubUrl(event.target.value)}
            />
          </label>
          <div className="form-actions form-span">
            <button
              type="button"
              className="primary"
              disabled={busy !== null || !githubUrl.trim()}
              onClick={() => void submitGithub()}
            >
              {busy === "github" ? "Saving…" : "Add GitHub link"}
            </button>
          </div>
          <label className="field form-span">
            <span className="field-label">Figma file link</span>
            <input
              value={figmaUrl}
              disabled={busy !== null}
              maxLength={2048}
              placeholder="https://www.figma.com/design/…"
              onChange={(event) => setFigmaUrl(event.target.value)}
            />
          </label>
          <div className="form-actions form-span">
            <button
              type="button"
              className="primary"
              disabled={busy !== null || !figmaUrl.trim()}
              onClick={() => void submitFigma()}
            >
              {busy === "figma" ? "Saving…" : "Add Figma link"}
            </button>
          </div>
        </div>
      ) : (
        <p className="notice">This team cannot submit review links.</p>
      )}

      <div className="repository-list">
        <div className="subheading-row">
          <h3>Submitted for review</h3>
          <span>
            {links.github.length}/{links.githubLimit} GitHub · {links.figma.length}/
            {links.figmaLimit} Figma
          </span>
        </div>
        {links.github.length === 0 && links.figma.length === 0 ? (
          <p className="muted">No review links have been added.</p>
        ) : (
          [...links.github, ...links.figma].map((link) => (
            <article className="repository-card" key={link.id}>
              <div className="repository-card-heading">
                <div>
                  <a href={link.url} target="_blank" rel="noreferrer">
                    {link.label}
                  </a>
                  <p>{link.kind === "github" ? "GitHub" : "Figma"}</p>
                </div>
                {links.canSubmit ? (
                  <button
                    type="button"
                    className="text-button quiet-danger"
                    disabled={busy !== null}
                    onClick={() => void remove(link)}
                  >
                    {busy === link.id ? "Removing…" : "Remove"}
                  </button>
                ) : null}
              </div>
            </article>
          ))
        )}
      </div>
      <ErrorNotice message={error} />
    </section>
  );
}
