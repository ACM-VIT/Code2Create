import type { ChangeEvent, ReactNode } from "react";
import {
  operationsAutonomyReadTools,
  operationsHealthAreas,
  operationsHealthSeverities,
} from "@code2create/domain";

import {
  allAutonomyRecommendationKinds as recommendationOptions,
  type AutonomyPolicy,
} from "../../lib/autonomyPolicy";

type OwnerOption = {
  eventAccessSubjectId: AutonomyPolicy["accountableOwnerEventAccessSubjectId"];
  displayName: string;
  email: string;
  canRead: boolean;
  canGenerate: boolean;
};

type PolicyChange = <Key extends keyof AutonomyPolicy>(
  key: Key,
  value: AutonomyPolicy[Key],
) => void;

const severityOptions = operationsHealthSeverities;
const areaOptions = operationsHealthAreas;
const readToolOptions = operationsAutonomyReadTools;
export function AutonomyPolicyFields({
  policy,
  ownerCanLoadMore,
  ownerLoading,
  ownerOptions,
  ownerSearch,
  onChange,
  onLoadMoreOwners,
  onModeChange,
  onOwnerSearchChange,
}: {
  policy: AutonomyPolicy;
  ownerCanLoadMore: boolean;
  ownerLoading: boolean;
  ownerOptions: readonly OwnerOption[];
  ownerSearch: string;
  onChange: PolicyChange;
  onLoadMoreOwners: () => void;
  onModeChange: (mode: AutonomyPolicy["mode"]) => void;
  onOwnerSearchChange: (value: string) => void;
}) {
  return (
    <>
      <PolicySection
        title="Operating mode"
        description="Recommend lets it draft actions for an operator to approve."
      >
        <label className="intelligence-enable">
          <input
            checked={policy.enabled}
            type="checkbox"
            onChange={(event) => onChange("enabled", event.currentTarget.checked)}
          />
          <span>Let the agent monitor on its own</span>
        </label>
        <div className="intake-purpose-list">
          {(["observe", "recommend"] as const).map((mode) => (
            <label key={mode}>
              <input
                checked={policy.mode === mode}
                name="autonomy-mode"
                type="radio"
                onChange={() => onModeChange(mode)}
              />
              <span>{humanize(mode)}</span>
            </label>
          ))}
        </div>
      </PolicySection>

      <PolicySection
        title="Signals and cadence"
        description="A qualifying signal starts a check right away; the schedule runs on its own cadence."
      >
        <ChoiceSet
          label="Signal level"
          options={severityOptions}
          values={policy.triggerSeverities}
          onChange={(values) => onChange("triggerSeverities", values)}
        />
        <ChoiceSet
          label="Event areas"
          options={areaOptions}
          values={policy.triggerAreas}
          onChange={(values) => onChange("triggerAreas", values)}
        />
        <div className="intake-policy-number-grid">
          <NumberField
            label="Scheduled check · minutes"
            min={1}
            max={60}
            value={policy.scheduleIntervalMinutes}
            onChange={(value) => onChange("scheduleIntervalMinutes", value)}
          />
        </div>
        <label className="field">
          <span>Escalate at</span>
          <select
            value={policy.escalationSeverity}
            onChange={(event) => {
              const severity = (["critical", "attention"] as const).find(
                (candidate) => candidate === event.currentTarget.value,
              );
              if (severity !== undefined) onChange("escalationSeverity", severity);
            }}
          >
            <option value="critical">Urgent</option>
            <option value="attention">Needs attention</option>
          </select>
        </label>
      </PolicySection>

      <PolicySection
        title="Evidence tools"
        description="Anything unticked stays unavailable to the agent."
      >
        <ChoiceSet
          label="Event information the agent may read"
          options={readToolOptions}
          requiredValues={["operations_health"]}
          values={policy.allowedReadTools}
          onChange={(values) => onChange("allowedReadTools", values)}
        />
        <p className="muted">Operations health is always included.</p>
      </PolicySection>

      {policy.mode === "recommend" ? (
        <PolicySection
          title="Recommendation scope"
          description="Actions the agent may draft for approval. The agent cannot execute them."
        >
          <ChoiceSet
            label="Allowed proposal kinds"
            options={recommendationOptions}
            values={policy.allowedRecommendationKinds}
            onChange={(values) => onChange("allowedRecommendationKinds", values)}
          />
        </PolicySection>
      ) : null}

      <PolicySection title="Authority boundary">
        <p className="notice">
          The agent may investigate as deeply as needed within the information above. It cannot
          change access, identity, participant state, judging, scores, notifications, money, or
          releases; a person confirms every such action.
        </p>
      </PolicySection>

      <PolicySection
        title="Accountable owner"
        description="Responsible for the agent; their access is checked again on every run."
      >
        <label className="field">
          <span>Find an event account</span>
          <input
            autoComplete="off"
            placeholder="Search by display name"
            type="search"
            value={ownerSearch}
            onChange={(event) => onOwnerSearchChange(event.currentTarget.value)}
          />
        </label>
        <label className="field">
          <span>Owner</span>
          <select
            required
            value={policy.accountableOwnerEventAccessSubjectId}
            onChange={(event) => {
              const owner = ownerOptions.find(
                (candidate) => candidate.eventAccessSubjectId === event.currentTarget.value,
              );
              if (owner !== undefined) {
                onChange("accountableOwnerEventAccessSubjectId", owner.eventAccessSubjectId);
              }
            }}
          >
            {ownerOptions.map((owner) => (
              <option
                disabled={!owner.canRead || (policy.mode === "recommend" && !owner.canGenerate)}
                key={owner.eventAccessSubjectId}
                value={owner.eventAccessSubjectId}
              >
                {owner.displayName} · {owner.email}
                {!owner.canRead ? " · access missing" : owner.canGenerate ? "" : " · observe only"}
              </option>
            ))}
          </select>
        </label>
        {ownerCanLoadMore ? (
          <button
            className="secondary"
            disabled={ownerLoading}
            type="button"
            onClick={onLoadMoreOwners}
          >
            {ownerLoading ? "Loading accounts…" : "Load more accounts"}
          </button>
        ) : ownerLoading ? (
          <p className="muted">Loading accounts…</p>
        ) : null}
      </PolicySection>
    </>
  );
}

function PolicySection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="intake-policy-section">
      <header>
        <h2>{title}</h2>
        {description === undefined ? null : <p className="muted">{description}</p>}
      </header>
      {children}
    </section>
  );
}

function ChoiceSet<Value extends string>({
  label,
  options,
  requiredValues = [],
  values,
  onChange,
}: {
  label: string;
  options: readonly Value[];
  requiredValues?: readonly Value[];
  values: Value[];
  onChange: (values: Value[]) => void;
}) {
  return (
    <fieldset className="intelligence-choice-set">
      <legend>{label}</legend>
      <div className="intake-purpose-list">
        {options.map((option) => (
          <label key={option}>
            <input
              checked={values.includes(option)}
              disabled={
                (requiredValues.includes(option) && values.includes(option)) ||
                (values.length === 1 && values.includes(option))
              }
              type="checkbox"
              onChange={(event) =>
                onChange(toggleValue(values, option, event.currentTarget.checked))
              }
            />
            <span>{humanize(option)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function NumberField({
  label,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (value: number) => void;
}) {
  const update = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.currentTarget.valueAsNumber;
    if (Number.isSafeInteger(next)) onChange(next);
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input max={max} min={min} required type="number" value={value} onChange={update} />
    </label>
  );
}

function toggleValue<Value>(values: Value[], value: Value, selected: boolean) {
  if (selected) return values.includes(value) ? values : [...values, value];
  return values.filter((candidate) => candidate !== value);
}

function humanize(value: string) {
  const labels: Readonly<Record<string, string>> = {
    admissions: "Applications",
    admission_jobs: "Admission jobs",
    attention: "Needs attention",
    attendance: "Check-in and presence",
    attendance_counts: "Attendance counts",
    attendance_operations: "Attendance operations",
    communications: "Participant messages",
    critical: "Urgent",
    dismiss_attention_item: "Dismiss an attention item",
    floor_mapping_progress: "Floor mapping progress",
    hold_review_team: "Hold a team in the review queue",
    intake: "Project intake",
    intake_jobs: "Intake jobs",
    incident_readiness: "Incident readiness",
    integration_jobs: "Integration jobs",
    integrations: "Code and design",
    observe: "Observe only",
    open_support_case: "Open a support case",
    operations_attention: "Operations attention queue",
    operations_health: "Operations health",
    participant_deliveries: "Participant deliveries",
    page_reserve_reviewer: "Page a reserve reviewer",
    recommend: "Observe and recommend",
    review_exceptions: "Reviewer exceptions",
    review_rounds: "Review rounds",
    reviews: "Judging",
    round_export_jobs: "Round export jobs",
    scores: "Results",
    support_load: "Support load",
    synesthesia: "Music desk",
    synesthesia_operations: "Synesthesia operations",
    system: "Platform",
    watch: "Watch",
  };
  const label = labels[value] ?? value.replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
