import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useAction, useMutation, useQuery } from "convex/react";
import { useState, type ChangeEvent, type FormEvent } from "react";

import {
  ConfigurationTabs,
  type ConfigurationTabsVisibility,
} from "../components/ConfigurationTabs";
import { ConfigurationEditorDisclosure } from "../components/ConfigurationEditorDisclosure";
import { PendingOperationRecovery } from "../components/PendingOperationRecovery";
import { LoadingLabel, SkeletonCard, SkeletonStats } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import {
  type ConfigurationOperationDescriptor,
  useConfigurationOperations,
} from "../lib/configurationOperations";
import { readableError } from "../lib/errors";
import { useEstimatedServerNow } from "../lib/useEstimatedServerNow";
import { useVersionedState } from "@code2create/web-forms";

type Configuration = FunctionReturnType<typeof api.noveltyConfiguration.current>;
type Policy = FunctionReturnType<typeof api.noveltyConfiguration.defaults>;
type Corpus = NonNullable<Configuration["draftCorpus"]>;
type CorpusEntry = Corpus["entries"][number];
type NoveltyOperationResult =
  | FunctionReturnType<typeof api.noveltyConfiguration.createDraft>
  | FunctionReturnType<typeof api.noveltyConfiguration.replaceEntries>
  | FunctionReturnType<typeof api.noveltyConfiguration.publish>;

const operationDescriptors = [
  {
    slot: "novelty-corpus-publish",
    title: "Finish publishing the idea comparison set",
    action: "Confirm earlier publication",
  },
  {
    slot: "novelty-corpus-import",
    title: "Finish preparing the idea comparison set",
    action: "Confirm earlier preparation",
  },
  {
    slot: "novelty-corpus-draft",
    title: "Finish saving the idea comparison draft",
    action: "Confirm earlier save",
  },
] satisfies readonly ConfigurationOperationDescriptor[];

export function NoveltyConfiguration({ tabs }: { tabs: ConfigurationTabsVisibility }) {
  const configuration = useQuery(api.noveltyConfiguration.current, { eventSlug });
  const serverNow = useEstimatedServerNow(configuration?.serverNow, 60_000);
  const defaults = useQuery(api.noveltyConfiguration.defaults, {});
  const createDraft = useMutation(api.noveltyConfiguration.createDraft);
  const replaceEntries = useAction(api.noveltyConfiguration.replaceEntries);
  const publish = useMutation(api.noveltyConfiguration.publish);
  const operations = useConfigurationOperations<NoveltyOperationResult>(operationDescriptors);
  const source = configuration?.draftCorpus ?? configuration?.publishedCorpus;
  const sourceKey =
    !configuration || !defaults
      ? "loading"
      : source
        ? `${source.id}:${source.revision}`
        : "defaults";
  const policyState = useVersionedState<Policy | null>(
    sourceKey,
    defaults
      ? {
          ...(source?.policy ?? defaults),
          distinctSimilarityBoundary: defaults.distinctSimilarityBoundary,
          commonSimilarityBoundary: defaults.commonSimilarityBoundary,
        }
      : null,
  );
  const policy = policyState.value;
  const setPolicy = policyState.update;
  const entriesState = useVersionedState(
    sourceKey,
    JSON.stringify(source?.entries ?? exampleEntries(), null, 2),
  );
  const entriesText = entriesState.value;
  const setEntriesText = entriesState.replace;
  const [draftReason, setDraftReason] = useState("Updated live originality feedback");
  const [importReason, setImportReason] = useState("Reviewed past projects for idea comparison");
  const [publishReason, setPublishReason] = useState("Approved the live idea comparison");
  const publishState = useVersionedState(sourceKey, false);
  const publishArmed = publishState.value;
  const setPublishArmed = publishState.replace;
  const { busy, error, operationPending, pendingOperation, setError } = operations;
  const draftPending = operations.hasPending("novelty-corpus-draft");
  const importPending = operations.hasPending("novelty-corpus-import");
  const publishPending = operations.hasPending("novelty-corpus-publish");

  if (configuration === undefined || defaults === undefined || policy === null) {
    return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading the idea comparison set</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    );
  }

  const updatePolicy = <Key extends keyof Policy>(key: Key, value: Policy[Key]) => {
    setPolicy((current) => (current ? { ...current, [key]: value } : current));
  };

  const saveDraft = (event: FormEvent) => {
    event.preventDefault();
    void operations.run(
      "novelty-corpus-draft",
      (clientOperationId) => () =>
        createDraft({
          eventSlug,
          policy,
          expectedEventVersion: configuration.eventVersion,
          ...(configuration.draftCorpus
            ? { expectedDraftCorpusId: configuration.draftCorpus.id }
            : {}),
          reason: draftReason,
          clientOperationId,
        }),
    );
  };

  const importEntries = () => {
    const draft = configuration.draftCorpus;
    if (!draft) return;
    void operations.run(
      "novelty-corpus-import",
      (clientOperationId) => () =>
        replaceEntries({
          eventSlug,
          corpusVersionId: draft.id,
          expectedRevision: draft.revision,
          entries: parseCorpusEntries(entriesText),
          reason: importReason,
          clientOperationId,
        }),
    );
  };

  const publishDraft = () => {
    const draft = configuration.draftCorpus;
    const checksum = draft?.checksum;
    if (!draft || !checksum || draft.importState !== "ready") return;
    void operations.run(
      "novelty-corpus-publish",
      (clientOperationId) => () =>
        publish({
          eventSlug,
          draftCorpusId: draft.id,
          expectedDraftRevision: draft.revision,
          expectedDraftChecksum: checksum,
          expectedEventVersion: configuration.eventVersion,
          reason: publishReason,
          clientOperationId,
        }),
      () => setPublishArmed(false),
    );
  };

  const confirmPendingOperation = () => {
    void operations.retryPending(() => {
      setPublishArmed(false);
    });
  };

  const readFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    void file
      .text()
      .then((contents) => setEntriesText(contents))
      .catch((caught) => setError(readableError(caught)));
  };

  const replacePreviewEntries = (entries: CorpusEntry[]) => {
    setEntriesText(JSON.stringify(entries, null, 2));
    setPublishArmed(false);
    setError(null);
  };

  const updatePreviewEntry = (index: number, update: (entry: CorpusEntry) => CorpusEntry) => {
    const preview = parseCorpusPreview(entriesText);
    if (!preview.ok) return;
    replacePreviewEntries(
      preview.entries.map((entry, entryIndex) => (entryIndex === index ? update(entry) : entry)),
    );
  };

  const addPreviewEntry = () => {
    const preview = parseCorpusPreview(entriesText);
    if (!preview.ok || preview.entries.length >= configuration.limits.maximumEntries) return;
    replacePreviewEntries([
      ...preview.entries,
      {
        sourceKey: `past-project-${crypto.randomUUID()}`,
        sourceYear: new Date(serverNow).getUTCFullYear(),
        themeLabel: "New project theme",
        summary: "",
        reflectionPrompt: "",
      },
    ]);
  };

  const removePreviewEntry = (index: number) => {
    const preview = parseCorpusPreview(entriesText);
    if (!preview.ok || preview.entries.length <= configuration.limits.minimumEntries) return;
    replacePreviewEntries(preview.entries.filter((_, entryIndex) => entryIndex !== index));
  };

  const draft = configuration.draftCorpus;
  const draftReady = draft?.importState === "ready" && Boolean(draft.checksum);
  const entriesPreview = parseCorpusPreview(entriesText);

  return (
    <section className="configuration-shell intake-policy-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading configuration-heading">
        <div>
          <p className="eyebrow">Applications</p>
          <h1>Idea originality</h1>
          <p className="muted">
            Compare new ideas with reviewed past projects and other ideas in this event.
          </p>
        </div>
      </header>

      <dl className="catalog-summary">
        <div>
          <dt>Status</dt>
          <dd>{configuration.publishedCorpus ? "Ready" : "Not published"}</dd>
        </div>
        <div>
          <dt>Past projects</dt>
          <dd>{configuration.publishedCorpus?.entryCount ?? 0}</dd>
        </div>
        <div>
          <dt>Live comparison</dt>
          <dd>{configuration.providerConfigured ? "Current event included" : "Unavailable"}</dd>
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

      {!operationPending && configuration.canDraft ? (
        <ConfigurationEditorDisclosure
          defaultOpen={Boolean(draft)}
          description="What participants see, and when feedback appears. Ideas are compared with past projects and with other teams’ ideas this year."
          title={draft ? "Continue idea-originality draft" : "Edit idea originality"}
        >
          <form className="configuration-editor intake-policy-editor" onSubmit={saveDraft}>
            <fieldset disabled={draftPending} style={{ display: "contents" }}>
              <div className="configuration-editor-heading">
                <div>
                  <p className="eyebrow">{draft ? "Replace draft changes" : "Create a draft"}</p>
                  <h2>Live feedback</h2>
                  <p className="muted">
                    Current drafts, saved ideas, and submissions are compared as teams work. A team
                    never compares with itself.
                  </p>
                </div>
              </div>
              <label className="field">
                <span>Name shown to participants</span>
                <input
                  required
                  minLength={3}
                  maxLength={80}
                  value={policy.label}
                  onChange={(event) => updatePolicy("label", event.currentTarget.value)}
                />
              </label>
              <details className="configuration-advanced">
                <summary>Feedback sensitivity and refresh</summary>
                <div className="intake-policy-number-grid">
                  <NumberField
                    label="Start feedback after · characters"
                    min={30}
                    max={200}
                    step={1}
                    value={policy.minimumIdeaLength}
                    onChange={(value) => updatePolicy("minimumIdeaLength", value)}
                  />
                  <NumberField
                    label="Pause after typing · milliseconds"
                    min={400}
                    max={2_000}
                    step={50}
                    value={policy.debounceMs}
                    onChange={(value) => updatePolicy("debounceMs", value)}
                  />
                  <NumberField
                    label="Maximum checks per team · per minute"
                    min={5}
                    max={60}
                    step={1}
                    value={policy.maximumRequestsPerMinute}
                    onChange={(value) => updatePolicy("maximumRequestsPerMinute", value)}
                  />
                </div>
              </details>
            </fieldset>
            <section className="configuration-save">
              <label className="field">
                <span>Why this changed</span>
                <textarea
                  disabled={draftPending}
                  required
                  value={draftReason}
                  onChange={(event) => setDraftReason(event.currentTarget.value)}
                />
              </label>
              <button
                className="primary"
                disabled={busy || draftReason.trim().length < 5}
                type="submit"
              >
                {busy
                  ? "Saving…"
                  : draftPending
                    ? "Confirm earlier draft"
                    : draft
                      ? "Replace draft"
                      : "Create draft"}
              </button>
            </section>
          </form>
        </ConfigurationEditorDisclosure>
      ) : null}

      {!operationPending && draft ? (
        <section className="catalog-review novelty-corpus-editor">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Draft changes</p>
              <h2>Past projects</h2>
              <p className="muted">Each project needs a short, supportive question for teams.</p>
            </div>
            <span className="status-pill">{importStateName(draft.importState)}</span>
          </div>
          {draft.importFailureCategory ? (
            <p className="notice error">
              The last project import failed. Check the file and try again.
            </p>
          ) : null}
          {entriesPreview.ok ? (
            <fieldset disabled={importPending} style={{ display: "contents" }}>
              <div className="novelty-project-preview">
                <div className="section-heading novelty-project-heading">
                  <p>
                    {entriesPreview.entries.length} project
                    {entriesPreview.entries.length === 1 ? "" : "s"} loaded
                  </p>
                  <button
                    className="secondary"
                    disabled={entriesPreview.entries.length >= configuration.limits.maximumEntries}
                    type="button"
                    onClick={addPreviewEntry}
                  >
                    Add past project
                  </button>
                </div>
                <div className="novelty-project-editors">
                  {entriesPreview.entries.map((entry, index) => (
                    <details className="novelty-project-editor" key={entry.sourceKey}>
                      <summary>
                        <strong>{entry.themeLabel || "Untitled project"}</strong>
                        <span>{entry.sourceYear}</span>
                      </summary>
                      <div className="novelty-project-editor-body">
                        <div className="form-grid">
                          <label className="field">
                            <span>Theme</span>
                            <input
                              required
                              value={entry.themeLabel}
                              onChange={(event) =>
                                updatePreviewEntry(index, (current) => ({
                                  ...current,
                                  themeLabel: event.currentTarget.value,
                                }))
                              }
                            />
                          </label>
                          <label className="field">
                            <span>Year</span>
                            <input
                              required
                              inputMode="numeric"
                              min={2000}
                              max={new Date(serverNow).getUTCFullYear()}
                              type="number"
                              value={entry.sourceYear}
                              onChange={(event) => {
                                const sourceYear = event.currentTarget.valueAsNumber;
                                if (Number.isFinite(sourceYear))
                                  updatePreviewEntry(index, (current) => ({
                                    ...current,
                                    sourceYear,
                                  }));
                              }}
                            />
                          </label>
                          <label className="field full-field">
                            <span>What the project did</span>
                            <textarea
                              required
                              value={entry.summary}
                              onChange={(event) =>
                                updatePreviewEntry(index, (current) => ({
                                  ...current,
                                  summary: event.currentTarget.value,
                                }))
                              }
                            />
                          </label>
                          <label className="field full-field">
                            <span>Question to help a similar team go further</span>
                            <textarea
                              required
                              value={entry.reflectionPrompt}
                              onChange={(event) =>
                                updatePreviewEntry(index, (current) => ({
                                  ...current,
                                  reflectionPrompt: event.currentTarget.value,
                                }))
                              }
                            />
                          </label>
                        </div>
                        <button
                          className="text-button"
                          disabled={
                            entriesPreview.entries.length <= configuration.limits.minimumEntries
                          }
                          type="button"
                          onClick={() => removePreviewEntry(index)}
                        >
                          Remove project
                        </button>
                      </div>
                    </details>
                  ))}
                </div>
              </div>
            </fieldset>
          ) : (
            <p className="notice error">{entriesPreview.message}</p>
          )}
          <div className="novelty-corpus-file-row">
            <label className="secondary file-button">
              Import project list
              <input
                accept="application/json,.json"
                disabled={importPending}
                type="file"
                onChange={readFile}
              />
            </label>
            <label className="field novelty-import-reason">
              <span>Why this list changed</span>
              <input
                disabled={importPending}
                required
                value={importReason}
                onChange={(event) => setImportReason(event.currentTarget.value)}
              />
            </label>
            {configuration.canWriteEntries ? (
              <button
                className="primary"
                disabled={busy || draft.importState === "running"}
                type="button"
                onClick={importEntries}
              >
                {busy || draft.importState === "running"
                  ? "Preparing…"
                  : importPending
                    ? "Confirm earlier import"
                    : "Prepare live comparison"}
              </button>
            ) : null}
          </div>
          <p className="muted novelty-file-requirements">
            Import a JSON list of {configuration.limits.minimumEntries}–
            {configuration.limits.maximumEntries} projects. Do not include names, contact details,
            or credentials.
          </p>
          {!configuration.providerConfigured ? (
            <p className="notice">
              Live comparison is unavailable. Add the event's OpenAI key before preparing this list.
            </p>
          ) : null}
        </section>
      ) : null}

      {!operationPending && draft && draftReady && configuration.canPublish ? (
        publishArmed ? (
          <section className="publish-confirmation catalog-publish">
            <h2>Publish this list of past projects?</h2>
            <p className="muted">Teams already writing keep their current comparison set.</p>
            <label className="field">
              <span>Why this changed</span>
              <textarea
                disabled={publishPending}
                required
                value={publishReason}
                onChange={(event) => setPublishReason(event.currentTarget.value)}
              />
            </label>
            <div className="button-row">
              <button
                className="primary"
                disabled={busy || publishReason.trim().length < 5}
                type="button"
                onClick={publishDraft}
              >
                {busy
                  ? "Publishing…"
                  : publishPending
                    ? "Confirm earlier publication"
                    : "Publish comparison set"}
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
        ) : (
          <section className="catalog-review">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Check before publishing</p>
                <h2>{draft.entryCount} past projects are ready</h2>
              </div>
              <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>
                Review before publishing
              </button>
            </div>
          </section>
        )
      ) : null}

      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function NumberField({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        required
        max={max}
        min={min}
        step={step}
        type="number"
        value={value}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </label>
  );
}

function parseCorpusEntries(value: string): CorpusEntry[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("The corpus file must contain one JSON array.");
  return parsed.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Project ${index + 1} must be one JSON object.`);
    return {
      sourceKey: requiredString(entry, "sourceKey", index),
      sourceYear: requiredNumber(entry, "sourceYear", index),
      themeLabel: requiredString(entry, "themeLabel", index),
      summary: requiredString(entry, "summary", index),
      reflectionPrompt: requiredString(entry, "reflectionPrompt", index),
    };
  });
}

type CorpusPreview = { ok: true; entries: CorpusEntry[] } | { ok: false; message: string };

function parseCorpusPreview(value: string): CorpusPreview {
  try {
    return { ok: true, entries: parseCorpusEntries(value) };
  } catch (caught) {
    return {
      ok: false,
      message: caught instanceof Error ? caught.message : "The project file is not valid JSON.",
    };
  }
}

function importStateName(value: Corpus["importState"]) {
  if (value === "empty") return "Needs projects";
  if (value === "running") return "Preparing";
  if (value === "ready") return "Ready";
  return "Needs attention";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(entry: Record<string, unknown>, key: string, index: number) {
  const value = entry[key];
  if (typeof value !== "string") throw new Error(`Project ${index + 1} needs a string ${key}.`);
  return value;
}

function requiredNumber(entry: Record<string, unknown>, key: string, index: number) {
  const value = entry[key];
  if (typeof value !== "number") throw new Error(`Project ${index + 1} needs a numeric ${key}.`);
  return value;
}

function exampleEntries(): CorpusEntry[] {
  return [
    {
      sourceKey: "c2c-2022-campus-routing",
      sourceYear: 2022,
      themeLabel: "Campus service routing",
      summary: "A campus request board that routes maintenance work to available volunteers.",
      reflectionPrompt: "What useful outcome happens after a request is assigned?",
    },
    {
      sourceKey: "c2c-2023-food-redistribution",
      sourceYear: 2023,
      themeLabel: "Food redistribution",
      summary: "A workflow that connects surplus canteen food with nearby community kitchens.",
      reflectionPrompt: "How will a kitchen know that a collection is still safe and available?",
    },
    {
      sourceKey: "c2c-2023-accessible-navigation",
      sourceYear: 2023,
      themeLabel: "Accessible navigation",
      summary: "A route planner that records temporary accessibility barriers around a campus.",
      reflectionPrompt: "How will the route stay useful when a barrier changes during the day?",
    },
    {
      sourceKey: "c2c-2024-study-planning",
      sourceYear: 2024,
      themeLabel: "Study planning",
      summary: "A shared study planner that turns course deadlines into manageable weekly tasks.",
      reflectionPrompt: "What makes the plan adapt when a student falls behind?",
    },
    {
      sourceKey: "c2c-2025-waste-sorting",
      sourceYear: 2025,
      themeLabel: "Waste sorting",
      summary: "A camera-assisted guide that explains how common campus waste should be sorted.",
      reflectionPrompt: "What will users do when the material cannot be identified confidently?",
    },
  ];
}
