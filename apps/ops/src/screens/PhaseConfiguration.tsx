import { api } from "@code2create/backend/api";
import { TZDateMini } from "@date-fns/tz";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState, type FormEvent } from "react";

import {
  ConfigurationTabs,
  type ConfigurationTabsVisibility,
} from "../components/ConfigurationTabs";
import { ConfigurationEditorDisclosure } from "../components/ConfigurationEditorDisclosure";
import { PendingOperationRecovery } from "../components/PendingOperationRecovery";
import { LoadingLabel, SkeletonCard, SkeletonStats } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import {
  formatZonedDateTimeWindow as formatWindow,
  formatZonedTime as formatTime,
} from "../lib/dateTime";
import {
  type ConfigurationOperationDescriptor,
  useConfigurationOperations,
} from "../lib/configurationOperations";
import { useVersionedState } from "@code2create/web-forms";

type Configuration = FunctionReturnType<typeof api.phaseConfiguration.current>;
type Schedule = NonNullable<Configuration["publishedSchedule"]>;
type SchedulePhase = Schedule["phases"][number];
type PhaseKey = SchedulePhase["phaseKey"];
type PhaseOperationResult =
  | FunctionReturnType<typeof api.phaseConfiguration.createDraft>
  | FunctionReturnType<typeof api.phaseConfiguration.publish>;

type EditorPhase = {
  phaseKey: PhaseKey;
  displayName: string;
  description: string;
  startsAt: string;
  endsAt: string;
};

const phaseDefaults = [
  {
    phaseKey: "introduction",
    displayName: "Introduction",
    description: "Welcome, orientation, and event setup.",
  },
  {
    phaseKey: "ideation",
    displayName: "Ideation",
    description: "Teams refine the problem, users, and approach.",
  },
  {
    phaseKey: "build",
    displayName: "Build",
    description: "The main hacking window.",
  },
  {
    phaseKey: "intermediate_update",
    displayName: "Intermediate update",
    description: "Teams record a short progress checkpoint.",
  },
  {
    phaseKey: "final_update",
    displayName: "Final update",
    description: "Teams complete the final project checkpoint.",
  },
] as const satisfies readonly {
  phaseKey: PhaseKey;
  displayName: string;
  description: string;
}[];

const operationDescriptors = [
  {
    slot: "phase-schedule-publish",
    title: "Finish publishing the event schedule",
    action: "Confirm earlier publication",
  },
  {
    slot: "phase-schedule-draft",
    title: "Finish saving the event schedule draft",
    action: "Confirm earlier save",
  },
] satisfies readonly ConfigurationOperationDescriptor[];

export function PhaseConfiguration({ tabs }: { tabs: ConfigurationTabsVisibility }) {
  const configuration = useQuery(api.phaseConfiguration.current, { eventSlug });
  const createDraft = useMutation(api.phaseConfiguration.createDraft);
  const publish = useMutation(api.phaseConfiguration.publish);
  const operations = useConfigurationOperations<PhaseOperationResult>(operationDescriptors);
  const validation = useQuery(
    api.phaseConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftSchedule
      ? { eventSlug, draftScheduleId: configuration.draftSchedule.id }
      : "skip",
  );
  const schedule = configuration?.draftSchedule ?? configuration?.publishedSchedule;
  const sourceKey = schedule
    ? `${schedule.id}:${schedule.checksum}`
    : `empty:${configuration?.timezone ?? "loading"}`;
  const phaseState = useVersionedState<EditorPhase[]>(
    sourceKey,
    schedule && configuration
      ? schedule.phases.map((phase) => toEditorPhase(phase, configuration.timezone))
      : phaseDefaults.map((phase) => ({ ...phase, startsAt: "", endsAt: "" })),
  );
  const phases = phaseState.value;
  const setPhases = phaseState.update;
  const [draftReason, setDraftReason] = useState("Aligned with the event run sheet");
  const [publishReason, setPublishReason] = useState(
    "Checked and approved for participant display",
  );
  const publishState = useVersionedState(sourceKey, false);
  const publishArmed = publishState.value;
  const setPublishArmed = publishState.replace;
  const { busy, error, operationPending, pendingOperation } = operations;
  const draftPending = operations.hasPending("phase-schedule-draft");
  const publishPending = operations.hasPending("phase-schedule-publish");

  if (configuration === undefined) {
    return (
      <section className="phase-config-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading the schedule</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    );
  }

  const updatePhase = (phaseKey: PhaseKey, patch: Partial<EditorPhase>) => {
    setPhases((current) =>
      current.map((phase) => (phase.phaseKey === phaseKey ? { ...phase, ...patch } : phase)),
    );
  };

  const saveDraft = (event: FormEvent) => {
    event.preventDefault();
    void operations.run(
      "phase-schedule-draft",
      (clientOperationId) => () =>
        createDraft({
          eventSlug,
          phases: phases.map((phase) => ({
            phaseKey: phase.phaseKey,
            displayName: phase.displayName,
            description: phase.description,
            startsAt: zonedTimestamp(
              phase.startsAt,
              configuration.timezone,
              `${phase.displayName} start`,
            ),
            endsAt: zonedTimestamp(
              phase.endsAt,
              configuration.timezone,
              `${phase.displayName} end`,
            ),
          })),
          expectedEventVersion: configuration.eventVersion,
          ...(configuration.draftSchedule
            ? { expectedDraftScheduleId: configuration.draftSchedule.id }
            : {}),
          reason: draftReason,
          clientOperationId,
        }),
    );
  };

  const publishDraft = () => {
    const draft = configuration.draftSchedule;
    if (!draft || !validation?.valid) return;
    void operations.run(
      "phase-schedule-publish",
      (clientOperationId) => () =>
        publish({
          eventSlug,
          draftScheduleId: draft.id,
          expectedDraftChecksum: draft.checksum,
          expectedEventVersion: configuration.eventVersion,
          reason: publishReason,
          clientOperationId,
        }),
      () => setPublishArmed(false),
    );
  };

  const confirmPendingOperation = () => {
    void operations.retryPending(() => setPublishArmed(false));
  };

  return (
    <section className="phase-config-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading configuration-heading">
        <div>
          <p className="eyebrow">Event flow</p>
          <h1>Event schedule</h1>
          <p className="muted">
            Five participant-visible windows in {configuration.timezone}. Gaps are allowed; overlaps
            are not.
          </p>
        </div>
      </header>

      <dl className="catalog-summary phase-summary">
        <div>
          <dt>Status</dt>
          <dd>{configuration.publishedSchedule ? "Ready" : "Not published"}</dd>
        </div>
        <div>
          <dt>Timezone</dt>
          <dd>{configuration.timezone}</dd>
        </div>
        <div>
          <dt>Phases</dt>
          <dd>5</dd>
        </div>
      </dl>

      {pendingOperation ? (
        <PendingOperationRecovery
          action={pendingOperation.action}
          busy={busy}
          onConfirm={() => void confirmPendingOperation()}
          title={pendingOperation.title}
        />
      ) : null}

      {configuration.publishedSchedule ? (
        <ol className="published-phase-list">
          {configuration.publishedSchedule.phases.map((phase) => (
            <li key={phase.phaseKey}>
              <div>
                <strong>{phase.displayName}</strong>
                <span>{phase.description}</span>
              </div>
              <time>{formatWindow(phase.startsAt, phase.endsAt, configuration.timezone)}</time>
            </li>
          ))}
        </ol>
      ) : (
        <p className="notice">No phase schedule is participant-visible yet.</p>
      )}

      {!operationPending && configuration.draftSchedule ? (
        <section className="catalog-review">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Draft changes</p>
              <h2>Before publishing</h2>
            </div>
            {configuration.canPublish && validation?.valid && !publishArmed ? (
              <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>
                Publish draft
              </button>
            ) : null}
          </div>
          {configuration.canValidate ? (
            validation === undefined ? (
              <p className="muted">Checking the draft…</p>
            ) : (
              <>
                <ul className="catalog-change-list">
                  {validation.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
                {validation.issues.length > 0 ? (
                  <ul className="catalog-issue-list">
                    {validation.issues.map((issue) => (
                      <li key={issue}>{issue}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="notice">
                    Valid at {formatTime(validation.evaluatedAt, configuration.timezone)}.
                  </p>
                )}
              </>
            )
          ) : (
            <p className="notice">You do not have permission to check this draft.</p>
          )}
        </section>
      ) : null}

      {!operationPending &&
      configuration.draftSchedule &&
      configuration.canPublish &&
      validation?.valid &&
      publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish this event schedule?</h2>
          <p className="muted">
            Participants see the new schedule immediately. Completed phases can no longer change.
          </p>
          <label className="field">
            <span>Why this changed</span>
            <textarea
              disabled={publishPending}
              required
              value={publishReason}
              onChange={(event) => setPublishReason(event.target.value)}
            />
          </label>
          <div className="button-row">
            <button
              className="primary"
              disabled={busy || publishReason.trim().length < 5}
              type="button"
              onClick={() => void publishDraft()}
            >
              {busy
                ? "Publishing…"
                : publishPending
                  ? "Confirm earlier publication"
                  : "Publish schedule"}
            </button>
            <button
              className="secondary"
              disabled={busy || publishPending}
              type="button"
              onClick={() => setPublishArmed(false)}
            >
              Cancel
            </button>
          </div>
        </section>
      ) : null}

      {!operationPending && configuration.canDraft ? (
        <ConfigurationEditorDisclosure
          defaultOpen={Boolean(configuration.draftSchedule)}
          description={`Participant-facing phase names, descriptions, and times in ${configuration.timezone}.`}
          title={configuration.draftSchedule ? "Continue schedule draft" : "Edit event schedule"}
        >
          <form className="phase-editor" onSubmit={saveDraft}>
            <fieldset disabled={draftPending} style={{ display: "contents" }}>
              <div className="configuration-editor-heading">
                <div>
                  <p className="eyebrow">
                    {configuration.draftSchedule ? "Replace current draft" : "Create a draft"}
                  </p>
                  <h2>Schedule</h2>
                  <p className="muted">
                    Times below use {configuration.timezone}, not the browser timezone.
                  </p>
                </div>
              </div>
              <div className="phase-card-list">
                {phases.map((phase, index) => (
                  <article className="phase-card" key={phase.phaseKey}>
                    <header>
                      <span>Phase {index + 1}</span>
                      <strong>{phase.displayName}</strong>
                    </header>
                    <div className="phase-field-grid">
                      <label className="field">
                        <span>Name</span>
                        <input
                          required
                          value={phase.displayName}
                          onChange={(event) =>
                            updatePhase(phase.phaseKey, { displayName: event.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Start · {configuration.timezone}</span>
                        <input
                          required
                          type="datetime-local"
                          value={phase.startsAt}
                          onChange={(event) =>
                            updatePhase(phase.phaseKey, { startsAt: event.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>End · {configuration.timezone}</span>
                        <input
                          required
                          type="datetime-local"
                          value={phase.endsAt}
                          onChange={(event) =>
                            updatePhase(phase.phaseKey, { endsAt: event.target.value })
                          }
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>Participant description</span>
                      <textarea
                        required
                        value={phase.description}
                        onChange={(event) =>
                          updatePhase(phase.phaseKey, { description: event.target.value })
                        }
                      />
                    </label>
                  </article>
                ))}
              </div>
            </fieldset>
            <section className="configuration-save">
              <label className="field">
                <span>Why this changed</span>
                <textarea
                  disabled={draftPending}
                  required
                  value={draftReason}
                  onChange={(event) => setDraftReason(event.target.value)}
                />
              </label>
              {phases.length === phaseDefaults.length ? null : (
                <p className="notice">
                  The schedule needs all {phaseDefaults.length} phases before it can be saved.
                </p>
              )}
              <button className="primary" disabled={busy} type="submit">
                {busy
                  ? "Saving…"
                  : draftPending
                    ? "Confirm earlier draft"
                    : configuration.draftSchedule
                      ? "Replace draft"
                      : "Save draft"}
              </button>
            </section>
          </form>
        </ConfigurationEditorDisclosure>
      ) : null}

      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function toEditorPhase(phase: SchedulePhase, timezone: string): EditorPhase {
  return {
    phaseKey: phase.phaseKey,
    displayName: phase.displayName,
    description: phase.description,
    startsAt: timestampInput(phase.startsAt, timezone),
    endsAt: timestampInput(phase.endsAt, timezone),
  };
}

function timestampInput(timestamp: number, timezone: string) {
  const date = new TZDateMini(timestamp, timezone);
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-") +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function zonedTimestamp(value: string, timezone: string, label: string) {
  const [datePart, timePart] = value.split("T");
  const datePieces = datePart?.split("-");
  const timePieces = timePart?.split(":");
  const year = Number(datePieces?.[0]);
  const month = Number(datePieces?.[1]);
  const day = Number(datePieces?.[2]);
  const hour = Number(timePieces?.[0]);
  const minute = Number(timePieces?.[1]);
  if ([year, month, day, hour, minute].some((part) => !Number.isInteger(part))) {
    throw new Error(`${label} is incomplete.`);
  }
  const date = new TZDateMini(year, month - 1, day, hour, minute, timezone);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    throw new Error(`${label} is not a valid local time in ${timezone}.`);
  }
  return date.getTime();
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
