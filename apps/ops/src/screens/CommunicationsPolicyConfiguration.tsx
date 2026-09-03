import { api } from "@code2create/backend/api";
import {
  participantEmailTemplateKeys,
  participantEmailTemplateLabels,
  type ParticipantEmailTemplateKey,
} from "@code2create/domain";
import { TZDateMini } from "@date-fns/tz";
import type { FunctionReturnType } from "convex/server";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import {
  ConfigurationTabs,
  type ConfigurationTabsVisibility,
} from "../components/ConfigurationTabs";
import { ConfigurationEditorDisclosure } from "../components/ConfigurationEditorDisclosure";
import { PendingOperationRecovery } from "../components/PendingOperationRecovery";
import { LoadingLabel, SkeletonCard, SkeletonStats } from "../components/Skeleton";
import { eventSlug } from "../lib/config";
import { formatZonedDateTimeWindow as formatWindow } from "../lib/dateTime";
import {
  type ConfigurationOperationDescriptor,
  useConfigurationOperations,
} from "../lib/configurationOperations";
import { useVersionedState } from "@code2create/web-forms";

type Configuration = FunctionReturnType<typeof api.communicationsPolicyConfiguration.current>;
type Policy = Configuration["publishedPolicy"]["policy"];
type NextStep = Policy["nextSteps"][number];
type EditorStep = Omit<NextStep, "dueAt"> & { dueAt: string };
type EditorPolicy = Omit<Policy, "nextSteps"> & { nextSteps: EditorStep[] };
type EmailTemplate = Policy["emailTemplates"][number];
type CommunicationsPolicyOperationResult =
  | FunctionReturnType<typeof api.communicationsPolicyConfiguration.createDraft>
  | FunctionReturnType<typeof api.communicationsPolicyConfiguration.publish>;

const operationDescriptors = [
  {
    slot: "communications-policy-publish",
    title: "Finish publishing participant communications",
    action: "Confirm earlier publication",
  },
  {
    slot: "communications-policy-draft",
    title: "Finish saving the participant communications draft",
    action: "Confirm earlier save",
  },
] satisfies readonly ConfigurationOperationDescriptor[];

export function CommunicationsPolicyConfiguration({ tabs }: { tabs: ConfigurationTabsVisibility }) {
  const configuration = useQuery(api.communicationsPolicyConfiguration.current, { eventSlug });
  const createDraft = useMutation(api.communicationsPolicyConfiguration.createDraft);
  const publish = useMutation(api.communicationsPolicyConfiguration.publish);
  const uploadEmailBundle = useAction(api.communicationsEmailAssetActions.uploadBundle);
  const operations =
    useConfigurationOperations<CommunicationsPolicyOperationResult>(operationDescriptors);
  const validation = useQuery(
    api.communicationsPolicyConfiguration.validateDraft,
    configuration?.canValidate && configuration.draftPolicy
      ? { eventSlug, draftPolicyId: configuration.draftPolicy.id }
      : "skip",
  );
  const source = configuration
    ? (configuration.draftPolicy ?? configuration.publishedPolicy)
    : null;
  const sourceKey = source ? `${source.id}:${source.checksum}` : "loading";
  const policyState = useVersionedState<EditorPolicy | null>(
    sourceKey,
    source && configuration ? toEditorPolicy(source.policy, configuration.timezone) : null,
  );
  const policy = policyState.value;
  const setPolicy = policyState.update;
  const [draftReason, setDraftReason] = useState("");
  const [publishReason, setPublishReason] = useState("");
  const [selectedEmail, setSelectedEmail] = useState<ParticipantEmailTemplateKey>("accept");
  const [emailAssetError, setEmailAssetError] = useState<string | null>(null);
  const [uploadingEmailBundle, setUploadingEmailBundle] = useState(false);
  const publishState = useVersionedState(sourceKey, false);
  const publishArmed = publishState.value;
  const setPublishArmed = publishState.replace;
  const { busy, error, operationPending, pendingOperation } = operations;
  const draftPending = operations.hasPending("communications-policy-draft");
  const publishPending = operations.hasPending("communications-policy-publish");

  if (configuration === undefined || policy === null) {
    return (
      <section className="intake-policy-shell">
        <ConfigurationTabs visibility={tabs} />
        <LoadingLabel>Loading participant communications</LoadingLabel>
        <SkeletonStats columns={3} />
        <SkeletonCard lines={4} />
      </section>
    );
  }

  const updatePolicy = <Key extends keyof EditorPolicy>(key: Key, value: EditorPolicy[Key]) => {
    setPolicy((current) => (current ? { ...current, [key]: value } : current));
  };

  const updateStep = (index: number, patch: Partial<EditorStep>) => {
    updatePolicy(
      "nextSteps",
      policy.nextSteps.map((step, stepIndex) =>
        stepIndex === index ? { ...step, ...patch } : step,
      ),
    );
  };

  const updateStepActionUrl = (index: number, actionUrl: string) => {
    updatePolicy(
      "nextSteps",
      policy.nextSteps.map((step, stepIndex) => {
        if (stepIndex !== index) return step;
        if (actionUrl) return { ...step, actionUrl };
        const { actionUrl: _removed, ...withoutActionUrl } = step;
        return withoutActionUrl;
      }),
    );
  };

  const addStep = () => {
    updatePolicy("nextSteps", [
      ...policy.nextSteps,
      {
        stableKey: `next_step_${policy.nextSteps.length + 1}`,
        title: "",
        detail: "",
        dueAt: "",
      },
    ]);
  };

  const removeStep = (index: number) => {
    updatePolicy(
      "nextSteps",
      policy.nextSteps.filter((_, stepIndex) => stepIndex !== index),
    );
  };

  const selectedEmailTemplate = policy.emailTemplates.find(
    (template) => template.templateKey === selectedEmail,
  );
  if (!selectedEmailTemplate) {
    throw new Error(`The ${selectedEmail} participant email template is missing.`);
  }

  const updateEmailTemplate = (patch: Partial<EmailTemplate>) => {
    updatePolicy(
      "emailTemplates",
      policy.emailTemplates.map((template) =>
        template.templateKey === selectedEmail ? { ...template, ...patch } : template,
      ),
    );
  };

  const removeEmailAssetBundle = () => {
    updatePolicy(
      "emailTemplates",
      policy.emailTemplates.map((template) => {
        if (template.templateKey !== selectedEmail) return template;
        const { assetBundleId: _removed, ...withoutBundle } = template;
        return withoutBundle;
      }),
    );
  };

  const importEmailBundle = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setEmailAssetError(null);
    setUploadingEmailBundle(true);
    try {
      const imported = await uploadEmailBundle({
        eventSlug,
        templateKey: selectedEmail,
        fileName: file.name,
        bytes: await file.arrayBuffer(),
        clientOperationId: crypto.randomUUID(),
      });
      updateEmailTemplate({ html: imported.html, assetBundleId: imported.bundleId });
    } catch (caught) {
      setEmailAssetError(
        caught instanceof Error ? caught.message : "The email ZIP could not be imported.",
      );
    } finally {
      setUploadingEmailBundle(false);
    }
  };

  const saveDraft = (event: FormEvent) => {
    event.preventDefault();
    void operations.run(
      "communications-policy-draft",
      (clientOperationId) => () =>
        createDraft({
          eventSlug,
          policy: fromEditorPolicy(policy, configuration.timezone),
          expectedEventVersion: configuration.eventVersion,
          ...(configuration.draftPolicy
            ? { expectedDraftPolicyId: configuration.draftPolicy.id }
            : {}),
          reason: draftReason,
          clientOperationId,
        }),
    );
  };

  const publishDraft = () => {
    const draft = configuration.draftPolicy;
    if (!draft || !validation?.valid) return;
    void operations.run(
      "communications-policy-publish",
      (clientOperationId) => () =>
        publish({
          eventSlug,
          draftPolicyId: draft.id,
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
    <section className="configuration-shell intake-policy-shell">
      <ConfigurationTabs visibility={tabs} />
      <header className="page-heading configuration-heading">
        <div>
          <h1>Participant communications</h1>
          <p className="muted">Controls accepted-team details and every admission email.</p>
        </div>
      </header>

      <dl className="catalog-summary">
        <div>
          <dt>Status</dt>
          <dd>Ready</dd>
        </div>
        <div>
          <dt>Venue</dt>
          <dd>{configuration.publishedPolicy.policy.venueName}</dd>
        </div>
        <div>
          <dt>Event window</dt>
          <dd>
            {formatWindow(
              configuration.publishedPolicy.policy.startsAt,
              configuration.publishedPolicy.policy.endsAt,
              configuration.timezone,
            )}
          </dd>
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

      {!operationPending && configuration.draftPolicy ? (
        <section className="catalog-review">
          <div className="section-heading">
            <div>
              <p className="muted">Draft changes</p>
              <h2>Before publishing</h2>
            </div>
            {configuration.canPublish && validation?.valid && !publishArmed ? (
              <button className="secondary" type="button" onClick={() => setPublishArmed(true)}>
                Review before publishing
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
                    Ready to publish. Queued email keeps its current wording.
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
      configuration.draftPolicy &&
      configuration.canPublish &&
      validation?.valid &&
      publishArmed ? (
        <section className="publish-confirmation catalog-publish">
          <h2>Publish these participant communications?</h2>
          <p className="muted">
            Portal details change straight away. New emails use the published wording.
          </p>
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
              onClick={() => void publishDraft()}
            >
              {busy
                ? "Publishing…"
                : publishPending
                  ? "Confirm earlier publication"
                  : "Publish details"}
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
          defaultOpen={Boolean(configuration.draftPolicy)}
          description="Venue details, participant next steps, Discord access, and all admission emails."
          title={
            configuration.draftPolicy
              ? "Continue participant communications draft"
              : "Edit participant communications"
          }
        >
          <form className="configuration-editor intake-policy-editor" onSubmit={saveDraft}>
            <fieldset disabled={draftPending} style={{ display: "contents" }}>
              <PolicySection
                title="Event details"
                description="Dates follow the event window and cannot be changed here."
              >
                <div className="intake-policy-grid">
                  <label className="field">
                    <span>Venue name</span>
                    <input
                      required
                      minLength={2}
                      maxLength={120}
                      value={policy.venueName}
                      onChange={(event) => updatePolicy("venueName", event.currentTarget.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Venue address</span>
                    <input
                      maxLength={300}
                      value={policy.venueAddress ?? ""}
                      onChange={(event) =>
                        updatePolicy("venueAddress", event.currentTarget.value || undefined)
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Map URL</span>
                    <input
                      type="url"
                      value={policy.venueMapUrl ?? ""}
                      onChange={(event) =>
                        updatePolicy("venueMapUrl", event.currentTarget.value || undefined)
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Event window</span>
                    <input
                      disabled
                      value={formatWindow(policy.startsAt, policy.endsAt, configuration.timezone)}
                    />
                  </label>
                </div>
              </PolicySection>

              <PolicySection
                title="Next steps"
                description="Shown in this order to accepted and offer-stage teams."
              >
                <div className="communications-step-list">
                  {policy.nextSteps.map((step, index) => (
                    <fieldset className="communications-step" key={`${step.stableKey}:${index}`}>
                      <legend>Step {index + 1}</legend>
                      <div className="intake-policy-grid">
                        <label className="field">
                          <span>Title</span>
                          <input
                            required
                            minLength={2}
                            maxLength={80}
                            value={step.title}
                            onChange={(event) =>
                              updateStep(index, { title: event.currentTarget.value })
                            }
                          />
                        </label>
                        <label className="field field-wide">
                          <span>Detail</span>
                          <textarea
                            required
                            minLength={5}
                            maxLength={300}
                            value={step.detail}
                            onChange={(event) =>
                              updateStep(index, { detail: event.currentTarget.value })
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Action URL</span>
                          <input
                            value={step.actionUrl ?? ""}
                            onChange={(event) =>
                              updateStepActionUrl(index, event.currentTarget.value)
                            }
                          />
                        </label>
                        <label className="field">
                          <span>Due time</span>
                          <input
                            type="datetime-local"
                            value={step.dueAt}
                            onChange={(event) =>
                              updateStep(index, { dueAt: event.currentTarget.value })
                            }
                          />
                        </label>
                      </div>
                      {policy.nextSteps.length > 1 ? (
                        <button
                          className="text-button"
                          type="button"
                          onClick={() => removeStep(index)}
                        >
                          Remove step
                        </button>
                      ) : null}
                    </fieldset>
                  ))}
                </div>
                {policy.nextSteps.length < 8 ? (
                  <button className="secondary" type="button" onClick={addStep}>
                    Add step
                  </button>
                ) : null}
              </PolicySection>

              <PolicySection
                title="Discord"
                description="This link is returned only to accepted and offer-stage teams."
              >
                <div className="intake-policy-grid">
                  <label className="field">
                    <span>Invite URL</span>
                    <input
                      required
                      type="url"
                      value={policy.discordUrl}
                      onChange={(event) => updatePolicy("discordUrl", event.currentTarget.value)}
                    />
                  </label>
                  <label className="field">
                    <span>Button label</span>
                    <input
                      required
                      minLength={2}
                      maxLength={60}
                      value={policy.discordLabel}
                      onChange={(event) => updatePolicy("discordLabel", event.currentTarget.value)}
                    />
                  </label>
                </div>
              </PolicySection>

              <PolicySection
                title="Participant emails"
                description="Edit and preview every email sent during admissions. Once published, queued emails keep the wording they were queued with."
              >
                <div className="email-template-workspace">
                  <nav className="email-template-rail" aria-label="Email">
                    {participantEmailTemplateKeys.map((templateKey) => (
                      <button
                        className={templateKey === selectedEmail ? "active" : ""}
                        key={templateKey}
                        type="button"
                        onClick={() => {
                          setSelectedEmail(templateKey);
                          setEmailAssetError(null);
                        }}
                      >
                        <span>{participantEmailTemplateLabels[templateKey]}</span>
                        <small>
                          {policy.emailTemplates.find(
                            (template) => template.templateKey === templateKey,
                          )?.assetBundleId
                            ? "bundle"
                            : "html + text"}
                        </small>
                      </button>
                    ))}
                  </nav>
                  <div className="email-template-editor">
                    <div className="section-heading email-template-heading">
                      <h3>{participantEmailTemplateLabels[selectedEmail]}</h3>
                      <span className="tag">Cloudflare Email Service</span>
                    </div>
                    <p className="muted email-placeholder-help">
                      Fields you can use:{" "}
                      {(["participant_name", "team_name", "event_name", "portal_url"] as const).map(
                        (field) => (
                          <code key={field}>{`{{${field}}}`}</code>
                        ),
                      )}
                    </p>
                    <label className="field">
                      <span>Subject</span>
                      <input
                        required
                        minLength={3}
                        maxLength={160}
                        value={selectedEmailTemplate.subject}
                        onChange={(event) =>
                          updateEmailTemplate({ subject: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Plain-text version</span>
                      <textarea
                        className="email-text-editor"
                        required
                        minLength={10}
                        maxLength={20000}
                        value={selectedEmailTemplate.text}
                        onChange={(event) =>
                          updateEmailTemplate({ text: event.currentTarget.value })
                        }
                      />
                    </label>
                    <label className="field">
                      <span>HTML version</span>
                      <textarea
                        className="email-html-editor"
                        required
                        minLength={20}
                        maxLength={250000}
                        spellCheck={false}
                        value={selectedEmailTemplate.html}
                        onChange={(event) =>
                          updateEmailTemplate({ html: event.currentTarget.value })
                        }
                      />
                    </label>
                    <div className="email-bundle-controls">
                      <label className="secondary file-button">
                        <input
                          accept=".zip,application/zip"
                          disabled={uploadingEmailBundle}
                          type="file"
                          onChange={(event) => void importEmailBundle(event)}
                        />
                        {uploadingEmailBundle ? "Checking ZIP…" : "Import HTML ZIP"}
                      </label>
                      {selectedEmailTemplate.assetBundleId ? (
                        <button
                          className="text-button"
                          type="button"
                          onClick={removeEmailAssetBundle}
                        >
                          Remove attached files
                        </button>
                      ) : null}
                    </div>
                    <p className="muted">
                      A ZIP must contain index.html and up to 24 PNG, JPEG, GIF, WebP, or PDF
                      assets. Imported HTML remains editable.
                    </p>
                    {emailAssetError ? (
                      <p className="notice error" role="alert">
                        {emailAssetError}
                      </p>
                    ) : null}
                  </div>
                  <EmailTemplatePreview template={selectedEmailTemplate} />
                </div>
              </PolicySection>
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
                    : configuration.draftPolicy
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

function PolicySection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="intake-policy-section">
      <header>
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </header>
      {children}
    </section>
  );
}

function EmailTemplatePreview({ template }: { template: EmailTemplate }) {
  const readBundle = useAction(api.communicationsEmailAssetActions.readBundle);
  const [assetPreview, setAssetPreview] = useState<{
    bundleId: string;
    sourceFileName: string;
    urls: Array<{ fileName: string; url: string }>;
  } | null>(null);
  const [previewError, setPreviewError] = useState<{ bundleId: string; message: string } | null>(
    null,
  );

  useEffect(() => {
    let disposed = false;
    const createdUrls: string[] = [];
    const bundleId = template.assetBundleId;
    if (!bundleId) return;
    void readBundle({ eventSlug, bundleId })
      .then((bundle) => {
        if (disposed) return;
        const next = bundle.assets
          .filter((asset) => asset.disposition === "inline")
          .map((asset) => {
            const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.contentType }));
            createdUrls.push(url);
            return { fileName: asset.fileName, url };
          });
        setAssetPreview({ bundleId, sourceFileName: bundle.sourceFileName, urls: next });
      })
      .catch((caught) => {
        if (!disposed) {
          setPreviewError({
            bundleId,
            message:
              caught instanceof Error ? caught.message : "The email assets could not be loaded.",
          });
        }
      });
    return () => {
      disposed = true;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [readBundle, template.assetBundleId]);

  const currentAssetPreview =
    assetPreview && assetPreview.bundleId === template.assetBundleId ? assetPreview : null;
  const currentPreviewError =
    previewError && previewError.bundleId === template.assetBundleId ? previewError : null;
  const assetUrls = currentAssetPreview?.urls ?? [];
  const error = currentPreviewError?.message ?? null;
  let preview = renderEmailPreview(template.html);
  for (const asset of assetUrls) {
    preview = preview
      .replaceAll(`src="${asset.fileName}"`, `src="${asset.url}"`)
      .replaceAll(`src='${asset.fileName}'`, `src='${asset.url}'`)
      .replaceAll(`url("${asset.fileName}")`, `url("${asset.url}")`)
      .replaceAll(`url('${asset.fileName}')`, `url('${asset.url}')`)
      .replaceAll(`url(${asset.fileName})`, `url(${asset.url})`);
  }

  return (
    <aside className="email-template-preview">
      <div>
        <p className="eyebrow">Live preview</p>
        <strong>{renderEmailPreview(template.subject)}</strong>
        {currentAssetPreview ? (
          <small className="muted">Assets from {currentAssetPreview.sourceFileName}</small>
        ) : null}
      </div>
      <iframe
        sandbox=""
        srcDoc={preview}
        title={`${participantEmailTemplateLabels[template.templateKey]} email preview`}
      />
      {error ? <p className="notice error">{error}</p> : null}
    </aside>
  );
}

function renderEmailPreview(value: string) {
  return value
    .replaceAll("{{participant_name}}", "Aarav")
    .replaceAll("{{team_name}}", "Team Sakura")
    .replaceAll("{{event_name}}", "Code2Create 7.0")
    .replaceAll("{{portal_url}}", "https://c2c.acmvit.in");
}

function toEditorPolicy(policy: Policy, timezone: string): EditorPolicy {
  return {
    ...policy,
    nextSteps: policy.nextSteps.map((step) => ({
      ...step,
      dueAt: step.dueAt === undefined ? "" : timestampInput(step.dueAt, timezone),
    })),
  };
}

function fromEditorPolicy(policy: EditorPolicy, timezone: string): Policy {
  return {
    ...policy,
    nextSteps: policy.nextSteps.map((step) => {
      const { dueAt, ...fields } = step;
      return {
        ...fields,
        ...(dueAt
          ? { dueAt: zonedTimestamp(dueAt, timezone, `${step.title || step.stableKey} due time`) }
          : {}),
      };
    }),
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
