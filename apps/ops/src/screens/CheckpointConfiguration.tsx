import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { useState, type SubmitEvent } from "react";
import { Link } from "react-router-dom";

import {
  ConfigurationTabs,
  type ConfigurationTabsVisibility,
} from "../components/ConfigurationTabs";
import { ConfigurationEditorDisclosure } from "../components/ConfigurationEditorDisclosure";
import { PendingOperationRecovery } from "../components/PendingOperationRecovery";
import { LoadingLabel, SkeletonCard, SkeletonLine, SkeletonStats } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import {
  type ConfigurationOperationDescriptor,
  useConfigurationOperations,
} from "../lib/configurationOperations";
import { useVersionedState } from "@code2create/web-forms";

type Configuration = FunctionReturnType<typeof api.checkpointConfiguration.current>;
type Plan = NonNullable<Configuration["publishedPlan"]>;
type Definition = Plan["definitions"][number];
type CheckpointOperationResult =
  | FunctionReturnType<typeof api.checkpointConfiguration.createDraft>
  | FunctionReturnType<typeof api.checkpointConfiguration.publish>;

type EditorDefinition = {
  checkpointKey: Definition["checkpointKey"];
  phaseKey: Definition["phaseKey"];
  displayName: string;
  prompt: string;
  followUpQuestion: string;
  graceMinutes: number;
};

const phaseLabels = {
  introduction: "Introduction",
  ideation: "Ideation",
  build: "Build",
  intermediate_update: "Intermediate update",
  final_update: "Final update",
} satisfies Record<Definition["phaseKey"], string>;

const defaults = [
  {
    checkpointKey: "ideation",
    phaseKey: "ideation",
    displayName: "Ideation update",
    prompt: "What changed about your idea after exploring it?",
    followUpQuestion: "What are you building first, and why?",
    graceMinutes: 240,
  },
  {
    checkpointKey: "intermediate_update",
    phaseKey: "intermediate_update",
    displayName: "Intermediate update",
    prompt: "What has your team built or learned since the last update?",
    followUpQuestion: "What is the next concrete thing your team will finish?",
    graceMinutes: 120,
  },
  {
    checkpointKey: "final_update",
    phaseKey: "final_update",
    displayName: "Final update",
    prompt: "What did your team finish?",
    followUpQuestion: "What should someone try or look at first?",
    graceMinutes: 60,
  },
] as const satisfies readonly EditorDefinition[];

const operationDescriptors = [
  {
    slot: "checkpoint-publish",
    title: "Finish publishing the team update prompts",
    action: "Confirm earlier publication",
  },
  {
    slot: "checkpoint-draft",
    title: "Finish saving the team update prompts draft",
    action: "Confirm earlier save",
  },
] satisfies readonly ConfigurationOperationDescriptor[];

export function CheckpointConfiguration({ tabs }: { tabs: ConfigurationTabsVisibility }) {
  const configuration = useQuery(api.checkpointConfiguration.current, { eventSlug });
  const createDraft = useMutation(api.checkpointConfiguration.createDraft);
  const publish = useMutation(api.checkpointConfiguration.publish);
  const operations = useConfigurationOperations<CheckpointOperationResult>(operationDescriptors);
  const validation = useQuery(
    api.checkpointConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftPlan
      ? { eventSlug, draftPlanId: configuration.draftPlan.id }
      : "skip",
  );
  const plan = configuration?.draftPlan ?? configuration?.publishedPlan;
  const sourceKey = plan ? `${plan.id}:${plan.checksum}` : "empty";
  const definitionState = useVersionedState<EditorDefinition[]>(
    sourceKey,
    plan
      ? plan.definitions.map((definition) => ({
          checkpointKey: definition.checkpointKey,
          phaseKey: definition.phaseKey,
          displayName: definition.displayName,
          prompt: definition.prompt,
          followUpQuestion: definition.followUpQuestion,
          graceMinutes: definition.graceMinutes,
        }))
      : defaults.map((definition) => ({ ...definition })),
  );
  const definitions = definitionState.value;
  const setDefinitions = definitionState.update;
  const [draftReason, setDraftReason] = useState("Aligned with the participant event flow");
  const [publishReason, setPublishReason] = useState("Checked against the published event phases");
  const publishState = useVersionedState(sourceKey, false);
  const publishArmed = publishState.value;
  const setPublishArmed = publishState.replace;
  const { busy, error, operationPending, pendingOperation } = operations;
  const draftPending = operations.hasPending("checkpoint-draft");
  const publishPending = operations.hasPending("checkpoint-publish");

  if (configuration === undefined)
    return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading the checkpoints</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    );

  const updateDefinition = (
    checkpointKey: EditorDefinition["checkpointKey"],
    patch: Partial<EditorDefinition>,
  ) => {
    setDefinitions((current) =>
      current.map((definition) =>
        definition.checkpointKey === checkpointKey ? { ...definition, ...patch } : definition,
      ),
    );
  };

  const saveDraft = (event: SubmitEvent) => {
    event.preventDefault();
    void operations.run(
      "checkpoint-draft",
      (clientOperationId) => () =>
        createDraft({
          eventSlug,
          definitions,
          expectedEventVersion: configuration.eventVersion,
          ...(configuration.draftPlan ? { expectedDraftPlanId: configuration.draftPlan.id } : {}),
          reason: draftReason,
          clientOperationId,
        }),
    );
  };

  const publishDraft = () => {
    const draft = configuration.draftPlan;
    if (!draft || !validation?.valid) return;
    void operations.run(
      "checkpoint-publish",
      (clientOperationId) => () =>
        publish({
          eventSlug,
          draftPlanId: draft.id,
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
    <section className="configuration-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading configuration-heading">
        <div>
          <p className="eyebrow">Participant flow</p>
          <h1>Team updates</h1>
          <p className="muted">
            Choose the short questions teams answer as the hack moves forward.
          </p>
        </div>
      </header>

      <div className="checkpoint-status-line">
        <span
          data-ready={Boolean(
            configuration.publishedPlan && configuration.hasPublishedPhaseSchedule,
          )}
        >
          {configuration.publishedPlan && configuration.hasPublishedPhaseSchedule
            ? "Live"
            : "Needs setup"}
        </span>
        <p>
          {configuration.publishedPlan
            ? "Three updates follow the event schedule."
            : "Publish these questions before teams can use them."}
        </p>
      </div>

      {!configuration.hasPublishedPhaseSchedule ? (
        <p className="notice checkpoint-schedule-notice">
          Team updates need a published event schedule.{" "}
          {tabs.showPhases ? (
            <Link to="/configuration/phases">Set the schedule</Link>
          ) : (
            "Ask the schedule owner to publish it."
          )}
        </p>
      ) : null}

      {pendingOperation ? (
        <PendingOperationRecovery
          action={pendingOperation.action}
          busy={busy}
          onConfirm={() => confirmPendingOperation()}
          title={pendingOperation.title}
        />
      ) : null}

      {configuration.publishedPlan ? (
        <section className="checkpoint-plan">
          <header>
            <div>
              <h2>What teams see</h2>
              <p>Each update opens with its phase and closes shortly after that phase ends.</p>
            </div>
          </header>
          <ol>
            {configuration.publishedPlan.definitions.map((definition, index) => (
              <li key={definition.checkpointKey}>
                <div className="checkpoint-plan-step" aria-hidden="true">
                  {index + 1}
                </div>
                <div className="checkpoint-plan-copy">
                  <span>{phaseLabels[definition.phaseKey]} phase</span>
                  <h3>{definition.displayName}</h3>
                  <div className="checkpoint-question-preview">
                    <p>{definition.prompt}</p>
                    <small>Then: {definition.followUpQuestion}</small>
                  </div>
                </div>
                <div className="checkpoint-plan-window">
                  <strong>
                    Open during {phaseLabels[definition.phaseKey].toLocaleLowerCase("en-IN")}
                  </strong>
                  <span>{checkpointCloseCopy(definition.graceMinutes)}</span>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : (
        <div className="health-empty checkpoint-empty">
          <strong>No team updates are live yet.</strong>
          <span>Create the three questions below, then publish them.</span>
        </div>
      )}

      {!operationPending && configuration.draftPlan ? (
        <section className="catalog-review">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Draft changes</p>
              <h2>Before publishing</h2>
            </div>
            {configuration.canPublish && validation?.valid && !publishArmed ? (
              <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>
                Review before publishing
              </button>
            ) : null}
          </div>
          {validation === undefined && configuration.canValidate ? (
            <SkeletonLine width="40%" />
          ) : null}
          {validation && !validation.valid ? (
            <ul className="issue-list">
              {validation.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          {validation?.valid ? <p className="notice">This draft is ready to publish.</p> : null}
          {publishArmed ? (
            <div className="publish-confirmation">
              <p>Teams already writing keep their current questions.</p>
              <label className="field">
                <span>Why this changed</span>
                <textarea
                  disabled={publishPending}
                  required
                  value={publishReason}
                  onChange={(event) => setPublishReason(event.target.value)}
                />
              </label>
              {configuration.hasPublishedPhaseSchedule ? null : (
                <p className="notice">
                  The schedule has to be published first.{" "}
                  {tabs.showPhases ? (
                    <>
                      <Link to="/configuration/phases">Publish the schedule</Link>.
                    </>
                  ) : (
                    "Ask someone with event schedule access to publish it."
                  )}
                </p>
              )}
              <div className="offer-actions">
                <button
                  className="secondary"
                  disabled={busy || publishPending}
                  type="button"
                  onClick={() => setPublishArmed(false)}
                >
                  Cancel
                </button>
                {configuration.hasPublishedPhaseSchedule ? (
                  <button
                    className="primary"
                    disabled={busy}
                    type="button"
                    onClick={() => publishDraft()}
                  >
                    {busy
                      ? "Publishing…"
                      : publishPending
                        ? "Confirm earlier publication"
                        : "Publish team updates"}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {!operationPending && configuration.canDraft ? (
        <ConfigurationEditorDisclosure
          defaultOpen={Boolean(configuration.draftPlan)}
          description="The three moments when teams explain what changed, what works, and what comes next."
          title={configuration.draftPlan ? "Continue team-update draft" : "Edit team updates"}
        >
          <form className="phase-editor" onSubmit={saveDraft}>
            <fieldset disabled={draftPending} style={{ display: "contents" }}>
              <div className="configuration-editor-heading">
                <div>
                  <p className="eyebrow">
                    {configuration.draftPlan ? "Replace current draft" : "Create a draft"}
                  </p>
                  <h2>Participant questions</h2>
                </div>
              </div>
              <div className="phase-card-list">
                {definitions.map((definition, index) => (
                  <article
                    className="phase-card checkpoint-editor-card"
                    key={definition.checkpointKey}
                  >
                    <header className="checkpoint-editor-card-heading">
                      <span>{index + 1}</span>
                      <div>
                        <small>{phaseLabels[definition.phaseKey]} phase</small>
                        <strong>{definition.displayName}</strong>
                      </div>
                    </header>
                    <div className="phase-field-grid">
                      <label className="field">
                        <span>Name teams see</span>
                        <input
                          required
                          value={definition.displayName}
                          onChange={(event) =>
                            updateDefinition(definition.checkpointKey, {
                              displayName: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Keep open after phase ends · minutes</span>
                        <input
                          min={0}
                          max={1440}
                          required
                          type="number"
                          value={definition.graceMinutes}
                          onChange={(event) =>
                            updateDefinition(definition.checkpointKey, {
                              graceMinutes: event.target.valueAsNumber,
                            })
                          }
                        />
                      </label>
                    </div>
                    <label className="field">
                      <span>Main question</span>
                      <textarea
                        required
                        value={definition.prompt}
                        onChange={(event) =>
                          updateDefinition(definition.checkpointKey, { prompt: event.target.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Follow-up question</span>
                      <textarea
                        required
                        value={definition.followUpQuestion}
                        onChange={(event) =>
                          updateDefinition(definition.checkpointKey, {
                            followUpQuestion: event.target.value,
                          })
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
              {definitions.length === 3 ? null : (
                <p className="notice">
                  A draft needs all three checkpoints. {definitions.length}{" "}
                  {definitions.length === 1 ? "is" : "are"} filled in.
                </p>
              )}
              <button className="primary" disabled={busy} type="submit">
                {busy
                  ? "Saving…"
                  : draftPending
                    ? "Confirm earlier draft"
                    : configuration.draftPlan
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

function checkpointCloseCopy(graceMinutes: number) {
  if (graceMinutes === 0) return "Closes when the phase ends";
  if (graceMinutes < 60) return `Closes ${graceMinutes} minutes after the phase ends`;
  if (graceMinutes % 60 === 0) {
    const hours = graceMinutes / 60;
    return `Closes ${hours} ${hours === 1 ? "hour" : "hours"} after the phase ends`;
  }
  return `Closes ${graceMinutes} minutes after the phase ends`;
}
