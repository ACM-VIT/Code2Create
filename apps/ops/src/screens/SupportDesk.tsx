import { LiveNumber } from "../components/LiveNumber";
import { Streamdown } from "streamdown";
import { api } from "@code2create/backend/api";
import {
  supportCaseCategoryLabels,
  supportCaseCategoryOrder,
  supportCaseStateLabels,
  type SupportCaseState,
} from "@code2create/domain";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useRef, useState, type SubmitEvent, type KeyboardEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { Icon, type IconName } from "../components/Icon";
import { LoadingLabel, SkeletonCard, SkeletonLine, SkeletonList } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { formatCompactDateTime, formatMediumDateTime } from "../lib/dateTime";
import { readableError } from "../lib/errors";
import { useMutationAttempt } from "../lib/operations";
import {
  groupSupportCases,
  supportEmptyQueueText,
  supportEventText,
  supportExcerpt,
  supportFilterCount,
  supportFilters,
  supportFirstReply,
  supportGuideNote,
  supportLeadSentence,
  supportMessageRole,
  supportMessageTag,
  supportOwnerReason,
  supportQueueGroup,
  supportRowOwner,
  supportRowStatus,
  supportRowTone,
  supportStatusChoices,
  supportUpdateReason,
  type SupportAction,
  type SupportCase,
  type SupportComposerMode,
  type SupportFilter,
  type SupportRowTone,
} from "../lib/supportDeskPresentation";
import { useEstimatedServerNow } from "../lib/useEstimatedServerNow";

type StaffList = FunctionReturnType<typeof api.support.staffList>;
type SupportCaseId = SupportCase["id"];
type SupportCategory = SupportCase["category"];
type PersonId = StaffList["currentPersonId"];
type OwnerCandidate = FunctionReturnType<typeof api.support.owners>[number];
type CreateStaffResult = FunctionReturnType<typeof api.support.createStaff>;
type UpdateStaffResult = FunctionReturnType<typeof api.support.updateStaff>;

const ageTickMs = 60 * 1000;
const collapseNoteAfter = 700;
const createSlot = "create-support-case";
const updateSlot = "update-support-case";
const statusSlot = "change-support-status";
const ownerSlot = "change-support-owner";

/**
 * The desk is a queue beside the request being worked on. The address bar
 * carries the open request, so a handoff link or a refresh lands on the same case.
 */
export function SupportDesk({ composing = false }: { composing?: boolean }) {
  const params = useParams<{ supportCaseId: string }>();
  const routeCaseId = params.supportCaseId ?? null;
  const navigate = useNavigate();
  const [filter, setFilter] = useState<SupportFilter>("active");
  const list = useQuery(api.support.staffList, { eventSlug, state: filter });
  const now = useEstimatedServerNow(list?.serverNow, ageTickMs);

  const groups = list === undefined ? [] : groupSupportCases(list.cases);
  const firstCaseId = groups[0]?.cases[0]?.id ?? null;
  const focusedCaseId = composing ? null : (routeCaseId ?? firstCaseId);
  const focused = composing || routeCaseId !== null;

  return (
    <section className={focused ? "support-desk-shell focused" : "support-desk-shell"}>
      <header className="page-heading support-desk-heading">
        <div>
          <p className="eyebrow">Participant support</p>
          <h1>Help desk</h1>
          {list === undefined ? (
            <SkeletonLine width="46%" />
          ) : (
            <p className="muted">{supportLeadSentence(filter, list.totals)}</p>
          )}
        </div>
        {list?.canCreate === true && !composing ? (
          <Link className="secondary" to="/support/new">
            Log a walk-up issue
          </Link>
        ) : null}
      </header>

      <div className="support-desk-layout">
        <aside className="support-queue" aria-label="Help requests">
          <div className="stage-filter support-filters">
            {supportFilters.map(([value, label]) => (
              <button
                aria-pressed={value === filter}
                className={value === filter ? "stage-chip active" : "stage-chip"}
                key={value}
                type="button"
                onClick={() => setFilter(value)}
              >
                {label}
                {list === undefined ? null : <span><LiveNumber value={supportFilterCount(value, list.totals)} /></span>}
              </button>
            ))}
          </div>
          {list === undefined ? (
            <>
              <LoadingLabel>Loading the help desk</LoadingLabel>
              <SkeletonList rows={5} />
            </>
          ) : groups.length === 0 ? (
            <p className="support-queue-empty">{supportEmptyQueueText(filter)}</p>
          ) : (
            <div className="support-queue-list">
              {groups.map((group) => (
                <section className="support-group" key={group.group}>
                  {groups.length > 1 ? (
                    <h2 className="support-group-label">
                      {group.label}
                      <span><LiveNumber value={group.cases.length} /></span>
                    </h2>
                  ) : null}
                  {group.cases.map((supportCase) => (
                    <QueueRow
                      key={supportCase.id}
                      now={now}
                      selected={supportCase.id === focusedCaseId}
                      supportCase={supportCase}
                    />
                  ))}
                </section>
              ))}
            </div>
          )}
          {list?.caseLimitReached === true ? (
            <p className="support-queue-note">
              Showing the 80 most recently changed requests. Narrow the filter to reach older ones.
            </p>
          ) : null}
        </aside>

        <div className="support-case-pane">
          {composing ? (
            <CreateCase onCreated={(supportCaseId) => navigate(`/support/${supportCaseId}`)} />
          ) : list === undefined ? (
            <div className="support-case" aria-hidden="true">
              <SkeletonCard lines={6} />
            </div>
          ) : focusedCaseId !== null ? (
            <CaseDetail
              currentPersonId={list.currentPersonId}
              key={focusedCaseId}
              supportCaseId={focusedCaseId}
            />
          ) : (
            <EmptyPane canCreate={list.canCreate} filter={filter} />
          )}
        </div>
      </div>
    </section>
  );
}

function QueueRow({
  now,
  selected,
  supportCase,
}: {
  now: number;
  selected: boolean;
  supportCase: SupportCase;
}) {
  const tone = supportRowTone(supportCase, now);
  const excerpt = supportExcerpt(supportCase.description);
  const owner = supportRowOwner(supportCase);
  return (
    <Link
      aria-current={selected ? "true" : undefined}
      className={selected ? "support-row selected" : "support-row"}
      to={`/support/${supportCase.id}`}
    >
      <span className={tone === "quiet" ? "row-glyph" : `row-glyph ${tone}`}>
        <Icon name={rowIcon(supportCase, tone)} />
      </span>
      <span className="support-row-main">
        <span className="support-row-title">
          <strong>{supportCase.reporterName}</strong>
          <span className="row-context">{supportCaseCategoryLabels[supportCase.category]}</span>
        </span>
        <span className="support-row-excerpt">
          {excerpt.viaGuide ? <em>Guide · </em> : null}
          {excerpt.text}
        </span>
        <span className="support-row-meta">
          <span>{supportRowStatus(supportCase, now)}</span>
          {owner === null ? null : (
            <span className={owner.missing ? "missing" : undefined}>{owner.label}</span>
          )}
        </span>
      </span>
    </Link>
  );
}

function rowIcon(supportCase: SupportCase, tone: SupportRowTone): IconName {
  const group = supportQueueGroup(supportCase);
  if (group === "safety") return "alert";
  if (group === "reply") return tone === "critical" ? "alert" : "clock";
  if (group === "reporter") return "pause";
  if (group === "working") return "lifebuoy";
  return "check";
}

function EmptyPane({ canCreate, filter }: { canCreate: boolean; filter: SupportFilter }) {
  const copy =
    filter === "active"
      ? {
          title: "The desk is clear.",
          detail: "New requests from participants and the Guide land here as they arrive.",
        }
      : filter === "resolved"
        ? {
            title: "Nothing resolved yet.",
            detail: "Resolved requests wait here until the desk closes them.",
          }
        : filter === "closed"
          ? { title: "Nothing closed yet.", detail: "Closed requests stay here for the record." }
          : {
              title: "No requests yet.",
              detail: "Requests from participants, reviewers and walk-ups all land here.",
            };
  return (
    <div className="support-case support-case-empty">
      <p className="eyebrow">Nothing to work on</p>
      <h2>{copy.title}</h2>
      <p className="muted">{copy.detail}</p>
      {canCreate ? (
        <Link className="secondary" to="/support/new">
          Log a walk-up issue
        </Link>
      ) : null}
    </div>
  );
}

function CreateCase({ onCreated }: { onCreated: (supportCaseId: SupportCaseId) => void }) {
  const createCase = useMutation(api.support.createStaff);
  const [category, setCategory] = useState<SupportCategory>("queue");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const createAttempt = useMutationAttempt<CreateStaffResult>();
  const createPending = createAttempt.hasPending(createSlot);
  const ready = description.trim().length >= 10;

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const normalizedDescription = description.trim();
    if (busyRef.current || normalizedDescription.length < 10) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await createAttempt.run(createSlot, () => {
        const args = {
          eventSlug,
          category,
          description: normalizedDescription,
          clientOperationId: crypto.randomUUID(),
        };
        return () => createCase(args);
      });
      setDescription("");
      onCreated(result.id);
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <article className="support-case">
      <Link className="back-link support-case-back" to="/support">
        ← Help desk
      </Link>
      <header className="support-case-heading">
        <div>
          <p className="eyebrow">Walk-up</p>
          <h2>Log a walk-up issue</h2>
          <p className="muted">
            It opens under your name. Take it or hand it on once it is logged.
          </p>
        </div>
      </header>
      <form className="support-create-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          Category
          <select
            disabled={busy || createPending}
            value={category}
            onChange={(event) => setCategory(parseCategory(event.target.value))}
          >
            {supportCaseCategoryOrder.map((value) => (
              <option key={value} value={value}>
                {supportCaseCategoryLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          What happened?
          <textarea
            autoFocus
            disabled={busy || createPending}
            maxLength={2000}
            minLength={10}
            placeholder="Who came to the desk, what they need, and anything already tried."
            required
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={submitOnModifierEnter}
          />
        </label>
        <div className="button-row">
          <button className="primary" disabled={busy || (!ready && !createPending)} type="submit">
            {busy ? "Saving…" : createPending ? "Confirm issue" : "Log issue"}
          </button>
          <Link className="secondary" to="/support">
            Cancel
          </Link>
        </div>
        {createPending ? (
          <p className="support-composer-hint">
            This issue wasn’t saved. Confirm it before logging another.
          </p>
        ) : null}
        {error ? <p className="notice error">{error}</p> : null}
      </form>
    </article>
  );
}

function CaseDetail({
  currentPersonId,
  supportCaseId,
}: {
  currentPersonId: PersonId;
  supportCaseId: string;
}) {
  const detail = useQuery(api.support.detail, { eventSlug, supportCaseId });
  const canManage = detail?.supportCase.canManage === true;
  const owners = useQuery(api.support.owners, canManage ? { eventSlug } : "skip");
  const updateCase = useMutation(api.support.updateStaff);
  const [mode, setMode] = useState<SupportComposerMode>("reply");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const formAttempt = useMutationAttempt<UpdateStaffResult>();
  const ownerAttempt = useMutationAttempt<UpdateStaffResult>();
  const statusAttempt = useMutationAttempt<UpdateStaffResult>();

  if (detail === undefined) {
    return (
      <article className="support-case" aria-busy="true">
        <LoadingLabel>Loading this request</LoadingLabel>
        <SkeletonCard lines={6} />
      </article>
    );
  }
  if (detail === null) {
    return (
      <article className="support-case">
        <Link className="back-link support-case-back" to="/support">
          ← Help desk
        </Link>
        <p className="review-blocked">This request is no longer available.</p>
      </article>
    );
  }

  const supportCase = detail.supportCase;
  const formPending = formAttempt.hasPending(updateSlot);
  const ownerPending = ownerAttempt.hasPending(ownerSlot);
  const statusPending = statusAttempt.hasPending(statusSlot);
  const message = text.trim();
  const wrote = message.length >= 2;
  const reporterFirstName = supportCase.reporterName.split(" ")[0] || supportCase.reporterName;

  const ownerPersonId = supportCase.ownerPersonId;
  const ownerName = supportCase.ownerName;
  const ownerChoices: OwnerCandidate[] = [...(owners ?? [])];
  if (
    ownerPersonId !== undefined &&
    ownerName !== undefined &&
    !ownerChoices.some((candidate) => candidate.personId === ownerPersonId)
  ) {
    ownerChoices.push({ personId: ownerPersonId, displayName: ownerName });
  }

  const guarded = async <Result,>(work: () => Promise<Result>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (caught) {
      setError(readableError(caught));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const save = (event: SubmitEvent) => {
    event.preventDefault();
    if (statusPending || (!wrote && !formPending)) return;
    void guarded(async () => {
      await formAttempt.run(updateSlot, () => {
        const publicNote = wrote && mode === "reply";
        const internalNote = wrote && mode === "note";
        const args = {
          eventSlug,
          supportCaseId: supportCase.id,
          expectedVersion: supportCase.version,
          clearOwner: false,
          ...(publicNote ? { publicNote: message } : {}),
          ...(internalNote ? { internalNote: message } : {}),
          reason: supportUpdateReason({ publicNote, internalNote, nextState: null }),
          clientOperationId: crypto.randomUUID(),
        };
        return () => updateCase(args);
      });
      setText("");
    });
  };

  const changeStatus = (nextState: SupportCaseState) => {
    if (nextState === supportCase.state || formPending || ownerPending || statusPending) return;
    void guarded(() =>
      statusAttempt.run(statusSlot, () => {
        const args = {
          eventSlug,
          supportCaseId: supportCase.id,
          expectedVersion: supportCase.version,
          nextState,
          clearOwner: false,
          reason: supportUpdateReason({ publicNote: false, internalNote: false, nextState }),
          clientOperationId: crypto.randomUUID(),
        };
        return () => updateCase(args);
      }),
    );
  };

  const changeOwner = (nextOwnerPersonId: PersonId | null, reason: string) => {
    void guarded(() =>
      ownerAttempt.run(ownerSlot, () => {
        const args = {
          eventSlug,
          supportCaseId: supportCase.id,
          expectedVersion: supportCase.version,
          ...(nextOwnerPersonId === null ? {} : { nextOwnerPersonId }),
          clearOwner: nextOwnerPersonId === null,
          reason,
          clientOperationId: crypto.randomUUID(),
        };
        return () => updateCase(args);
      }),
    );
  };

  const selectOwner = (value: string) => {
    if (value === "") {
      changeOwner(null, supportOwnerReason({ kind: "release" }));
      return;
    }
    const target = ownerChoices.find((candidate) => candidate.personId === value);
    if (target === undefined) return;
    changeOwner(
      target.personId,
      target.personId === currentPersonId
        ? supportOwnerReason({ kind: "claim" })
        : supportOwnerReason({ kind: "handoff", displayName: target.displayName }),
    );
  };

  return (
    <article className="support-case">
      <Link className="back-link support-case-back" to="/support">
        ← Help desk
      </Link>
      <header className="support-case-heading">
        <div>
          <p className="eyebrow">
            {supportCaseCategoryLabels[supportCase.category]} · {supportCase.publicCode}
          </p>
          <h2>{supportCase.reporterName}</h2>
          <p className="support-case-facts">
            <a href={`mailto:${supportCase.contactEmail}`}>{supportCase.contactEmail}</a>
            {supportCase.teamName === undefined ? null : <span>Team {supportCase.teamName}</span>}
            {supportCase.roundName === undefined ? null : <span>{supportCase.roundName}</span>}
            {supportCase.subjectName === undefined ||
            supportCase.subjectName === supportCase.reporterName ? null : (
              <span>About {supportCase.subjectName}</span>
            )}
            <span>Reported {formatCompactDateTime(supportCase.createdAt)}</span>
            <span>{supportFirstReply(supportCase.createdAt, supportCase.firstResponseAt)}</span>
          </p>
        </div>
        <span className="state-label">{supportCaseStateLabels[supportCase.state]}</span>
      </header>

      {supportCase.canManage ? (
        <div className="support-owner">
          <label className="field support-owner-field">
            Owner
            <select
              disabled={busy || statusPending || ownerPending || owners === undefined}
              value={ownerPersonId ?? ""}
              onChange={(event) => selectOwner(event.target.value)}
            >
              <option value="">Nobody yet</option>
              {ownerChoices.map((candidate) => (
                <option key={candidate.personId} value={candidate.personId}>
                  {candidate.personId === currentPersonId
                    ? `${candidate.displayName} (you)`
                    : candidate.displayName}
                </option>
              ))}
            </select>
          </label>
          {supportCase.ownedByViewer ? null : (
            <button
              className="secondary"
              disabled={busy || statusPending || ownerPending}
              type="button"
              onClick={() => changeOwner(currentPersonId, supportOwnerReason({ kind: "claim" }))}
            >
              Take it
            </button>
          )}
          {ownerPending ? (
            <p className="support-composer-hint">
              The owner change did not confirm.{" "}
              <button
                className="text-button"
                disabled={busy}
                type="button"
                onClick={() => void guarded(() => ownerAttempt.retryPending(ownerSlot))}
              >
                Try again
              </button>
            </p>
          ) : null}
        </div>
      ) : null}

      <ol className="support-thread">
        {detail.actions.some((action) => action.kind === "opened") ? null : (
          <li className="support-message reporter">
            <div className="support-message-head">
              <strong>{supportCase.reporterName}</strong>
              <span>opened the request</span>
              <Stamp at={supportCase.createdAt} />
            </div>
            <MessageBody text={supportCase.description} />
          </li>
        )}
        {detail.actions.map((action) => (
          <ThreadItem action={action} key={action.id} />
        ))}
      </ol>

      {supportCase.canManage ? (
        <form
          className={mode === "note" ? "support-composer note" : "support-composer"}
          onSubmit={save}
        >
          <div aria-label="Write as" className="support-composer-tabs" role="tablist">
            <button
              aria-selected={mode === "reply"}
              className={mode === "reply" ? "active" : undefined}
              role="tab"
              type="button"
              onClick={() => setMode("reply")}
            >
              Reply to {reporterFirstName}
            </button>
            <button
              aria-selected={mode === "note"}
              className={mode === "note" ? "active" : undefined}
              role="tab"
              type="button"
              onClick={() => setMode("note")}
            >
              Desk note
            </button>
          </div>
          <textarea
            aria-label={
              mode === "reply" ? "Reply the reporter will see" : "Note only the desk will see"
            }
            disabled={busy || formPending}
            maxLength={2000}
            placeholder={
              mode === "reply"
                ? `Write to ${reporterFirstName}. They see it in the portal.`
                : "Only the desk sees this."
            }
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={submitOnModifierEnter}
          />
          <div className="support-composer-actions">
            <div className="field support-status-field">
              <span id="support-status-label">Status</span>
              <div
                className="support-status-buttons"
                role="group"
                aria-labelledby="support-status-label"
                aria-busy={statusPending && busy}
              >
                {supportStatusChoices(supportCase.state).map((state) => (
                  <button
                    aria-pressed={state === supportCase.state}
                    className="secondary"
                    disabled={
                      busy || formPending || ownerPending || statusPending || state === supportCase.state
                    }
                    key={state}
                    type="button"
                    onClick={() => changeStatus(state)}
                  >
                    {supportCaseStateLabels[state]}
                    {state === supportCase.state ? " (now)" : ""}
                  </button>
                ))}
              </div>
            </div>
            <button
              className="primary"
              disabled={busy || statusPending || (!wrote && !formPending)}
              type="submit"
            >
              {busy
                ? "Saving…"
                : formPending
                  ? "Confirm update"
                  : mode === "reply"
                    ? "Send reply"
                    : "Add note"}
            </button>
          </div>
          {statusPending ? (
            <p className="support-composer-hint" role="status">
              {busy ? "Saving status…" : (
                <>
                  The status change did not confirm.{" "}
                  <button
                    className="text-button"
                    disabled={busy}
                    type="button"
                    onClick={() => void guarded(() => statusAttempt.retryPending(statusSlot))}
                  >
                    Try again
                  </button>
                </>
              )}
            </p>
          ) : null}
          <p className="support-composer-hint">
            Status changes save immediately.{" "}
            {mode === "reply"
              ? "Waiting on a reply parks it with the reporter. "
              : "Desk notes never reach the reporter. "}
            ⌘ or Ctrl + Enter sends.
          </p>
        </form>
      ) : (
        <p className="review-blocked">You can read this request but not update it.</p>
      )}
      {error ? <p className="notice error">{error}</p> : null}
    </article>
  );
}

function ThreadItem({ action }: { action: SupportAction }) {
  const role = supportMessageRole(action);
  if (role === "system") {
    return (
      <li className="support-event">
        <span>{supportEventText(action)}</span>
        <Stamp at={action.createdAt} />
      </li>
    );
  }
  const guide =
    role === "guide" && action.body !== undefined ? supportGuideNote(action.body) : null;
  return (
    <li className={`support-message ${role}`}>
      <div className="support-message-head">
        <strong>{action.actorName}</strong>
        <span>{supportMessageTag(action)}</span>
        <Stamp at={action.createdAt} />
      </div>
      <MessageBody text={guide?.text ?? action.body ?? ""} />
    </li>
  );
}

function Stamp({ at }: { at: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={formatMediumDateTime(at)}>
      {formatCompactDateTime(at)}
    </time>
  );
}

/** Links in a note stay as text: the Guide writes portal-relative paths that mean nothing on this origin. */
const messageMarkdownComponents = {
  a: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
};

function MessageBody({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const shown =
    expanded || text.length <= collapseNoteAfter
      ? text
      : `${text.slice(0, collapseNoteAfter).trimEnd()}…`;
  return (
    <>
      <Streamdown mode="static" className="support-message-body" components={messageMarkdownComponents}>
        {shown}
      </Streamdown>
      {shown === text ? null : (
        <button className="text-button" type="button" onClick={() => setExpanded(true)}>
          Show the whole note
        </button>
      )}
    </>
  );
}

function submitOnModifierEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function parseCategory(value: string): SupportCategory {
  return supportCaseCategoryOrder.find((category) => category === value) ?? "queue";
}
