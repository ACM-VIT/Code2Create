import { api } from "@code2create/backend/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState, type SubmitEvent } from "react";
import { eventSlug } from "../lib/config";
import { readableError } from "../lib/errors";
import { useOperationRunner } from "../lib/operations";
import { FigmaMark } from "./dashboard/IntegrationsTile";
import { ToolNotice, ToolSheet } from "./integrations/ToolKit";
import { PortalButton, PortalTextButton } from "./portal/PortalButton";
import { PortalError, PortalField, PortalInput } from "./portal/PortalField";

export function FigmaIntegrationPanel() {
  const link = useQuery(api.figmaLinks.current, { eventSlug });
  const save = useMutation(api.figmaLinks.save);
  const operations =
    useOperationRunner<FunctionReturnType<typeof api.figmaLinks.save>>();
  const [draft, setDraft] = useState<{
    fileUrl: string;
    version: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const pending = operations.hasPending("figma-link-save");

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!link || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await operations.run("figma-link-save", (clientOperationId) => {
        const args = {
          eventSlug,
          fileUrl: draft?.fileUrl ?? link.fileUrl ?? "",
          expectedVersion: draft?.version ?? link.version,
          clientOperationId,
        };
        return () => save(args);
      });
      setDraft(null);
      setSaved(true);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  }

  if (link === null) return null;
  return (
    <ToolSheet
      mark={
        link?.fileUrl ? (
          <a
            href={link.fileUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View Figma design"
            title="View Figma design"
          >
            <FigmaMark className="size-6" />
          </a>
        ) : (
          <FigmaMark className="size-6" />
        )
      }
      name="Figma"
      meta="your team's design file"
    >
      {link === undefined ? (
        <p className="m-0 text-sm text-fg/55" role="status">
          Loading Figma link…
        </p>
      ) : (
        <>
          {link.canEdit ? (
            <form className="grid gap-4" onSubmit={submit}>
              <PortalField label="Figma file link">
                {(id) => (
                  <PortalInput
                    id={id}
                    type="url"
                    maxLength={2000}
                    placeholder="https://www.figma.com/design/…"
                    value={draft?.fileUrl ?? link.fileUrl ?? ""}
                    disabled={busy || pending}
                    onChange={(event) => {
                      setDraft({
                        fileUrl: event.target.value,
                        version: draft?.version ?? link.version,
                      });
                      setSaved(false);
                    }}
                  />
                )}
              </PortalField>
              <ToolNotice>Give reviewers access to view the file.</ToolNotice>
              <PortalError message={error} />
              <div className="flex flex-wrap items-center gap-4">
                <PortalButton
                  size="xs"
                  type="submit"
                  disabled={busy || (!pending && draft === null)}
                >
                  {busy ? "Saving…" : pending ? "Retry save" : "Save link"}
                </PortalButton>
                {draft && !pending ? (
                  <PortalTextButton
                    type="button"
                    onClick={() => {
                      setDraft(null);
                      setError(null);
                    }}
                  >
                    Cancel
                  </PortalTextButton>
                ) : null}
                {saved ? (
                  <span className="text-sm text-fg/60" role="status">
                    Link saved
                  </span>
                ) : null}
              </div>
            </form>
          ) : !link.fileUrl ? (
            <ToolNotice>Your team hasn't added a Figma link.</ToolNotice>
          ) : null}
        </>
      )}
    </ToolSheet>
  );
}
