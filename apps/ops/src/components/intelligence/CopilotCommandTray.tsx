import { LiveNumber } from "../LiveNumber";
import { api } from "@code2create/backend/api";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useState } from "react";

import { eventSlug } from "../../lib/config";
import { readableError } from "../../lib/errors";
import { useOperationRunner } from "../../lib/operations";
import {
  recommendationCommandRows,
  recommendationStatusLabel,
  recommendationStatusTone,
} from "../../lib/recommendationPresentation";

type CommandRows = FunctionReturnType<typeof api.intelligenceRecommendations.copilotConversation>;
type CommandRow = CommandRows[number];
type CommandResult = FunctionReturnType<typeof api.intelligenceRecommendations.approve>;

export function CopilotCommandTray() {
  const commands = useQuery(api.intelligenceRecommendations.copilotConversation, { eventSlug });
  const operations = useOperationRunner<CommandResult>();
  if (commands === undefined || commands.length === 0) return null;

  return (
    <section aria-label="Copilot command approvals" className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-3 px-0.5">
        <p className="m-0 text-[12px] font-medium text-ink-2">Needs your approval</p>
        <span className="text-[12px] text-ink-3 tabular-nums"><LiveNumber value={commands.length} /></span>
      </div>
      {commands.slice(-3).map((command) => (
        <CopilotCommandCard command={command} key={command.id} operations={operations} />
      ))}
    </section>
  );
}

function CopilotCommandCard({
  command,
  operations,
}: {
  command: CommandRow;
  operations: ReturnType<typeof useOperationRunner<CommandResult>>;
}) {
  const approve = useMutation(api.intelligenceRecommendations.approve);
  const reject = useMutation(api.intelligenceRecommendations.reject);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const approveSlot = `ask:${command.id}:approve`;
  const rejectSlot = `ask:${command.id}:reject`;
  const pendingSlot = operations.hasPending(approveSlot)
    ? approveSlot
    : operations.hasPending(rejectSlot)
      ? rejectSlot
      : undefined;

  const approveCommand = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await operations.run(
        approveSlot,
        (clientOperationId) => () =>
          approve({
            eventSlug,
            recommendationId: command.id,
            expectedVersion: command.version,
            clientOperationId,
          }),
      );
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const rejectCommand = async () => {
    const note = reason.trim();
    if (note.length < 5) {
      setError("Write at least a few words so the agent knows why.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await operations.run(
        rejectSlot,
        (clientOperationId) => () =>
          reject({
            eventSlug,
            recommendationId: command.id,
            expectedVersion: command.version,
            clientOperationId,
            reason: note,
          }),
      );
      setRejecting(false);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  const retryPending = async () => {
    if (pendingSlot === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      await operations.retryPending(pendingSlot);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="overflow-hidden rounded-xl border border-line bg-field/55 shadow-[0_12px_32px_rgb(0_0_0/0.08)]">
      <div className="flex items-start justify-between gap-4 px-3.5 pt-3 pb-2.5">
        <div className="min-w-0">
          <p className="m-0 text-[12.5px] font-semibold leading-snug text-ink">
            {command.statement}
          </p>
          <p className="mt-1 mb-0 text-[11.5px] leading-normal text-ink-3">{command.reasoning}</p>
        </div>
        <span
          className={`inline-flex h-5.5 shrink-0 items-center rounded-full px-2 text-[11px] ${recommendationStatusTone(command.status)}`}
        >
          {recommendationStatusLabel(command.status)}
        </span>
      </div>

      <CommandDetails command={command} />

      {command.status === "proposed" ? (
        <div className="border-t border-line px-3.5 py-3">
          {pendingSlot === undefined ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="cursor-pointer rounded-lg border border-green/30 bg-green px-3 py-1.5 text-[11.5px] font-semibold text-canvas transition-[filter,transform] duration-150 hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy}
                onClick={() => void approveCommand()}
                type="button"
              >
                Approve and run
              </button>
              <button
                className="cursor-pointer rounded-lg border border-line-strong bg-transparent px-3 py-1.5 text-[11.5px] font-medium text-ink-2 transition-colors duration-150 hover:bg-hover-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                disabled={busy}
                onClick={() => {
                  setRejecting((current) => !current);
                  setError(undefined);
                }}
                type="button"
              >
                Reject
              </button>
              <span className="text-[10.5px] text-ink-3">
                Permissions, lifecycle, and versions are checked again.
              </span>
            </div>
          ) : (
            <button
              className="cursor-pointer rounded-lg border border-amber/30 bg-amber/10 px-3 py-1.5 text-[11.5px] font-semibold text-amber disabled:cursor-not-allowed disabled:opacity-50"
              disabled={busy}
              onClick={() => void retryPending()}
              type="button"
            >
              Confirm the earlier {pendingSlot === approveSlot ? "approval" : "rejection"}
            </button>
          )}

          {rejecting && pendingSlot === undefined ? (
            <div className="mt-3 flex flex-col gap-2 border-l-2 border-line-strong pl-3">
              <label
                className="text-[12px] font-medium text-ink"
                htmlFor={`ask-reject-${command.id}`}
              >
                Why should this not run?
              </label>
              <textarea
                className="min-h-18 w-full resize-y rounded-lg border border-line bg-canvas px-2.5 py-2 text-[12px] leading-normal text-ink outline-none transition-colors focus:border-line-strong"
                id={`ask-reject-${command.id}`}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Tell the agent what to do differently…"
                value={reason}
              />
              <div>
                <button
                  className="cursor-pointer rounded-lg border border-line-strong bg-ink px-3 py-1.5 text-[11.5px] font-semibold text-canvas disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void rejectCommand()}
                  type="button"
                >
                  Reject command
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {error === undefined ? null : (
        <p
          className="m-0 border-t border-red/20 bg-red/5 px-3.5 py-2.5 text-[11.5px] leading-normal text-red"
          role="alert"
        >
          {error}
        </p>
      )}
    </article>
  );
}

function CommandDetails({ command }: { command: CommandRow }) {
  return (
    <dl className="m-0 grid border-t border-line px-3.5 py-1">
      {recommendationCommandRows(command.arguments).map((row) => (
        <div
          className="grid grid-cols-[120px_minmax(0,1fr)] gap-3 border-t border-line py-1.5 first:border-t-0"
          key={row.label}
        >
          <dt className="text-[11.5px] leading-5 text-ink-3">{row.label}</dt>
          <dd
            className={`m-0 truncate text-[12px] leading-5 text-ink-2 ${row.code ? "font-mono text-[11.5px]" : ""}`}
            title={String(row.value)}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
