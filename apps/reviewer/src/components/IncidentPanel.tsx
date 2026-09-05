import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useMutation, useQuery } from "convex/react";
import { randomUUID } from "expo-crypto";
import { useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  Action,
  Body,
  Card,
  ChipRow,
  Field,
  Lead,
  Meta,
  Nothing,
  Problem,
  QuietAction,
  Section,
  Sheet,
} from "@/components/ui";
import { describeError } from "@/lib/errors";
import { useMutationAttempt } from "@/lib/mutation-attempt";
import type { ReviewerRuntime } from "@/lib/runtime";
import { duty, palette } from "@/theme";
import { CaseListSkeleton } from "@/components/skeletons";

type ServiceKey = "attendance_backend" | "review_backend";
type ForService = FunctionReturnType<typeof api.incidents.forService>;
type Incident = ForService["incidents"][number] & { service: ServiceKey };
type IncidentSeverity = Incident["severity"];
type CreateResult = FunctionReturnType<typeof api.incidents.create>;
type ApproveResult = FunctionReturnType<typeof api.incidents.approveManualMode>;
type ResolveResult = FunctionReturnType<typeof api.incidents.resolve>;

const serviceLabels: Record<ServiceKey, string> = {
  attendance_backend: "Door scanning",
  review_backend: "Judging",
};

const severityOptions = [
  ["service_disruption", "Disruption"],
  ["major", "Major"],
  ["critical", "Critical"],
] as const;

export function IncidentPanel({ runtime }: { runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug;
  const door = useQuery(api.incidents.forService, {
    eventSlug,
    affectedService: "attendance_backend",
  });
  const judging = useQuery(api.incidents.forService, {
    eventSlug,
    affectedService: "review_backend",
  });
  const [selectedId, setSelectedId] = useState<Incident["id"] | null>(null);
  const [declaring, setDeclaring] = useState(false);

  if (door === undefined || judging === undefined) return <CaseListSkeleton />;

  const incidents: Incident[] = [
    ...door.incidents.map((incident) => ({ ...incident, service: "attendance_backend" as const })),
    ...judging.incidents.map((incident) => ({ ...incident, service: "review_backend" as const })),
  ].sort((left, right) => right.openedAt - left.openedAt);
  const live = incidents.filter((incident) => incident.state !== "resolved");
  const settled = incidents.filter((incident) => incident.state === "resolved").slice(0, 3);
  const selected = live.find((incident) => incident.id === selectedId);
  const canCreate = door.canCreate || judging.canCreate;

  return (
    <>
      <Lead
        accent={live.length > 0 ? duty.incident.accent : palette.text}
        unit={live.length === 1 ? "incident live" : "incidents live"}
        value={String(live.length)}
      />

      {live.length === 0 ? (
        <Nothing>Nothing is declared broken.</Nothing>
      ) : (
        <Section title="Live">
          {live.map((incident) => (
            <Card
              key={incident.id}
              onPress={() => setSelectedId(incident.id)}
              selected={incident.severity === "critical"}
            >
              <View style={styles.cardTop}>
                <Text style={styles.title}>{incident.title}</Text>
                <Text style={styles.severity}>{severityWord(incident.severity)}</Text>
              </View>
              <Body>{incident.summary}</Body>
              <Meta>{`${serviceLabels[incident.service]} · since ${formatTime(incident.openedAt)}`}</Meta>
              {paperLine(incident) ? <Meta>{paperLine(incident)}</Meta> : null}
            </Card>
          ))}
        </Section>
      )}

      {settled.length > 0 ? (
        <Section title="Settled">
          {settled.map((incident) => (
            <Card key={incident.id}>
              <View style={styles.cardTop}>
                <Text style={styles.title}>{incident.title}</Text>
                <Meta>
                  {incident.resolvedAt === undefined
                    ? "Resolved"
                    : `Resolved ${formatTime(incident.resolvedAt)}`}
                </Meta>
              </View>
              <Meta>{serviceLabels[incident.service]}</Meta>
            </Card>
          ))}
        </Section>
      ) : null}

      {canCreate ? (
        <Action
          accent={duty.incident.accent}
          label="Declare an incident"
          onPress={() => setDeclaring(true)}
        />
      ) : null}

      <IncidentSheet
        eventSlug={eventSlug}
        incident={selected}
        onClose={() => setSelectedId(null)}
        visible={selectedId !== null}
      />
      {canCreate ? (
        <DeclareSheet
          eventSlug={eventSlug}
          onClose={() => setDeclaring(false)}
          visible={declaring}
        />
      ) : null}
    </>
  );
}

function IncidentSheet({
  eventSlug,
  incident,
  onClose,
  visible,
}: {
  eventSlug: string;
  incident: Incident | undefined;
  onClose: () => void;
  visible: boolean;
}) {
  const approve = useMutation(api.incidents.approveManualMode);
  const resolve = useMutation(api.incidents.resolve);
  const [step, setStep] = useState<"facts" | "approve" | "resolve">("facts");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const approveAttempt = useMutationAttempt<ApproveResult>();
  const resolveAttempt = useMutationAttempt<ResolveResult>();
  const approvalPending = approveAttempt.hasPending("approve-manual-mode");
  const resolutionPending = resolveAttempt.hasPending("resolve-incident");
  const commandPending = approvalPending || resolutionPending;

  const finishAndClose = () => {
    setStep("facts");
    setReason("");
    setError(null);
    onClose();
  };
  const close = () => {
    if (!commandPending) finishAndClose();
  };

  const submitApproval = async () => {
    const normalizedReason = reason.trim();
    if (busyRef.current || !incident || normalizedReason.length < 5) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await approveAttempt.run("approve-manual-mode", () => {
        const args = {
          eventSlug,
          incidentId: incident.id,
          expectedIncidentVersion: incident.version,
          reason: normalizedReason,
          clientOperationId: randomUUID(),
        };
        return () => approve(args);
      });
      finishAndClose();
    } catch (caught) {
      setError(describeError(caught, "The approval could not be recorded."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const submitResolution = async () => {
    const normalizedReason = reason.trim();
    if (busyRef.current || !incident || normalizedReason.length < 5) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await resolveAttempt.run("resolve-incident", () => {
        const args = {
          eventSlug,
          incidentId: incident.id,
          expectedIncidentVersion: incident.version,
          reason: normalizedReason,
          clientOperationId: randomUUID(),
        };
        return () => resolve(args);
      });
      finishAndClose();
    } catch (caught) {
      setError(describeError(caught, "The incident could not be resolved."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Sheet onClose={close} title={incident?.title ?? "Incident"} visible={visible}>
      {!incident ? (
        <Nothing>This was resolved while you were reading.</Nothing>
      ) : (
        <>
          <Body>{incident.summary}</Body>
          <Meta>
            {`${serviceLabels[incident.service]} · ${severityWord(incident.severity)} · since ${formatTime(incident.openedAt)}`}
          </Meta>
          {paperLine(incident) ? <Meta>{paperLine(incident)}</Meta> : null}
          {incident.approvals.length > 0 ? (
            <Meta>
              {`Approved by ${incident.approvals.map((approval) => approval.displayName).join(" · ")}`}
            </Meta>
          ) : null}
          {error ? <Problem>{error}</Problem> : null}

          {step === "approve" ? (
            <>
              <Field
                editable={!busy && !approvalPending}
                label="Why paper is needed"
                maxLength={300}
                multiline
                onChangeText={setReason}
                placeholder="What is down, as you can see it."
                value={reason}
              />
              <Action
                accent={duty.incident.accent}
                disabled={busy || reason.trim().length < 5}
                label={
                  busy
                    ? "Approving…"
                    : approvalPending
                      ? "Confirm approval"
                      : "Approve paper fallback"
                }
                onPress={submitApproval}
              />
            </>
          ) : step === "resolve" ? (
            <>
              <Field
                editable={!busy && !resolutionPending}
                label="How service recovered"
                maxLength={300}
                multiline
                onChangeText={setReason}
                placeholder="What came back, and how you know."
                value={reason}
              />
              <Action
                accent={duty.incident.accent}
                disabled={busy || reason.trim().length < 5}
                label={
                  busy ? "Resolving…" : resolutionPending ? "Confirm resolution" : "Resolve it"
                }
                onPress={submitResolution}
              />
            </>
          ) : (
            <>
              {incident.canApproveManualMode ? (
                <Action
                  accent={duty.incident.accent}
                  label="Approve paper fallback"
                  disabled={commandPending}
                  onPress={() => {
                    setError(null);
                    setStep("approve");
                  }}
                />
              ) : null}
              {incident.canResolve ? (
                incident.canApproveManualMode ? (
                  <QuietAction
                    label="Resolve it"
                    disabled={commandPending}
                    onPress={() => {
                      setError(null);
                      setStep("resolve");
                    }}
                  />
                ) : (
                  <Action
                    accent={duty.incident.accent}
                    label="Resolve it"
                    disabled={commandPending}
                    onPress={() => {
                      setError(null);
                      setStep("resolve");
                    }}
                  />
                )
              ) : null}
            </>
          )}
        </>
      )}
    </Sheet>
  );
}

function DeclareSheet({
  eventSlug,
  onClose,
  visible,
}: {
  eventSlug: string;
  onClose: () => void;
  visible: boolean;
}) {
  const create = useMutation(api.incidents.create);
  const [service, setService] = useState<ServiceKey>("attendance_backend");
  const [severity, setSeverity] = useState<IncidentSeverity>("service_disruption");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const createAttempt = useMutationAttempt<CreateResult>();
  const createPending = createAttempt.hasPending("create-incident");

  const ready = title.trim().length >= 3 && summary.trim().length >= 10;

  const finishAndClose = () => {
    setError(null);
    onClose();
  };
  const close = () => {
    if (!createPending) finishAndClose();
  };

  const declare = async () => {
    if (busyRef.current || !ready) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await createAttempt.run("create-incident", () => {
        const args = {
          eventSlug,
          title: title.trim(),
          summary: summary.trim(),
          severity,
          affectedService: service,
          clientOperationId: randomUUID(),
        };
        return () => create(args);
      });
      setTitle("");
      setSummary("");
      finishAndClose();
    } catch (caught) {
      setError(describeError(caught, "The incident could not be declared."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Sheet
      footer={
        <Action
          accent={duty.incident.accent}
          disabled={busy || !ready}
          label={busy ? "Declaring…" : createPending ? "Confirm declaration" : "Declare it"}
          onPress={declare}
        />
      }
      onClose={close}
      title="Declare an incident"
      visible={visible}
    >
      <ChipRow
        accent={duty.incident.accent}
        onSelect={(value: ServiceKey) => {
          if (!createPending) setService(value);
        }}
        options={[
          ["attendance_backend", serviceLabels.attendance_backend],
          ["review_backend", serviceLabels.review_backend],
        ]}
        selected={service}
      />
      <ChipRow
        accent={duty.incident.accent}
        onSelect={(value: IncidentSeverity) => {
          if (!createPending) setSeverity(value);
        }}
        options={severityOptions}
        selected={severity}
      />
      <Field
        editable={!busy && !createPending}
        label="What to call it"
        maxLength={100}
        onChangeText={(value) => {
          setTitle(value);
        }}
        placeholder="Scanners down at the main door"
        value={title}
      />
      <Field
        editable={!busy && !createPending}
        label="What is happening"
        maxLength={500}
        multiline
        onChangeText={(value) => {
          setSummary(value);
        }}
        placeholder="Short and factual is enough."
        value={summary}
      />
      {error ? <Problem>{error}</Problem> : null}
      {createPending ? <Meta>Confirm the earlier declaration before starting another.</Meta> : null}
    </Sheet>
  );
}

function severityWord(severity: IncidentSeverity) {
  if (severity === "critical") return "Critical";
  if (severity === "major") return "Major";
  return "Disruption";
}

function paperLine(incident: Incident) {
  if (incident.manualModeState === "pending") {
    return `Paper fallback: ${incident.manualModeApprovalCount} of 2 approvals`;
  }
  if (incident.manualModeState === "approved") return "Paper fallback approved";
  return null;
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

const styles = StyleSheet.create({
  cardTop: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
  },
  title: { flexShrink: 1, color: palette.text, fontSize: 17, fontWeight: "600" },
  severity: { color: palette.urgent, fontSize: 15, fontWeight: "600" },
});
