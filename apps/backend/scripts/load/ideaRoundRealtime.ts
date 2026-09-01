import { readFile } from "node:fs/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { resolve } from "node:path";

import { ConvexClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { z } from "zod";

import { api } from "../../convex/_generated/api.js";

const configurationSchema = z.object({
  C2C_LOAD_ACKNOWLEDGE: z.string().optional(),
  C2C_LOAD_ACTIVE_PARTICIPANT_PERCENT: z.coerce.number().min(1).max(100).default(25),
  C2C_LOAD_AUTOSAVE_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  C2C_LOAD_CLIENTS: z.coerce.number().int().min(1).max(5_000).default(3_000),
  C2C_LOAD_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  C2C_LOAD_CONVEX_URL: z.url(),
  C2C_LOAD_EVENT_SLUG: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).default("code2create-7"),
  C2C_LOAD_HOLD_MS: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
  C2C_LOAD_MODE: z.enum(["public", "participant"]).default("public"),
  C2C_LOAD_NOVELTY_MS: z.coerce.number().int().min(5_000).max(120_000).default(15_000),
  C2C_LOAD_RAMP_MS: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
  C2C_LOAD_TOKEN_FILE: z.string().min(1).optional(),
  C2C_LOAD_WORKLOAD: z
    .enum(["subscriptions", "idea-editing", "intake-burst"])
    .default("subscriptions"),
}).passthrough();

const tokenFileSchema = z.array(z.string().min(20));

type IntakeSnapshot = FunctionReturnType<typeof api.intake.current>;
type ReadyIntakeSnapshot = NonNullable<IntakeSnapshot>;
type ReadinessSurface = "intake" | "profile" | "public";

type ClientState = {
  client: ConvexClient;
  clientIndex: number;
  completedAt: number | null;
  errors: number;
  intakeSnapshot: IntakeSnapshot | undefined;
  intakeListeners: Set<(snapshot: IntakeSnapshot) => void>;
  intakeReady: boolean;
  notReadyReasons: Partial<Record<ReadinessSurface, string>>;
  personId: string | null;
  profileReady: boolean;
  publicReady: boolean;
  startedAt: number;
  teamId: string | null;
  teamMaximumSize: number | null;
  unsubscribe: Array<() => void>;
  updates: number;
};

type WorkloadMeasurements = {
  attempted: number;
  errors: number;
  heartbeatLatencies: number[];
  autosaveLatencies: number[];
  noveltyLatencies: number[];
  noveltyReady: number;
  noveltyUnavailable: number;
};

type IntakeBurstMeasurements = {
  attempted: number;
  errors: number;
  failedTeams: number;
  fixedQuestions: number;
  modelQuestions: number;
  fallbackQuestions: number;
  modelAssistedTeams: number;
  teamsReachedReview: number;
  saveLatencies: number[];
  answerLatencies: number[];
  adaptiveResolutionLatencies: number[];
  teamCompletionLatencies: number[];
  maximumModelQuestionsPerTeam: number;
  teamsWithExactlyTwoFixedQuestions: number;
};

function delay(milliseconds: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function waitForIntake(
  state: ClientState,
  predicate: (snapshot: ReadyIntakeSnapshot) => boolean,
  timeoutMs: number,
) {
  return new Promise<ReadyIntakeSnapshot>((resolveSnapshot, rejectSnapshot) => {
    let settled = false;
    const finish = (snapshot: ReadyIntakeSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.intakeListeners.delete(listener);
      resolveSnapshot(snapshot);
    };
    const listener = (snapshot: IntakeSnapshot) => {
      if (snapshot && predicate(snapshot)) finish(snapshot);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      state.intakeListeners.delete(listener);
      rejectSnapshot(new Error(`Client ${state.clientIndex + 1} timed out waiting for intake state.`));
    }, timeoutMs);
    state.intakeListeners.add(listener);
    const current = state.intakeSnapshot;
    if (current && predicate(current)) finish(current);
  });
}

function percentile(sortedValues: readonly number[], quantile: number) {
  if (sortedValues.length === 0) return null;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * quantile) - 1),
  );
  return sortedValues[index] ?? null;
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 240) : "Unknown subscription error";
}

function markReady(state: ClientState, surface: ReadinessSurface) {
  delete state.notReadyReasons[surface];
  if (surface === "intake") state.intakeReady = true;
  else if (surface === "profile") state.profileReady = true;
  else state.publicReady = true;
  if (
    state.completedAt === null &&
    state.publicReady &&
    state.profileReady &&
    state.intakeReady
  ) {
    state.completedAt = performance.now();
  }
}

function markNotReady(
  state: ClientState,
  surface: ReadinessSurface,
  reason: string,
) {
  const wasReady = surface === "intake"
    ? state.intakeReady
    : surface === "profile"
      ? state.profileReady
      : state.publicReady;
  if (surface === "intake") state.intakeReady = false;
  else if (surface === "profile") state.profileReady = false;
  else state.publicReady = false;
  if (wasReady) state.errors += 1;
  state.completedAt = null;
  state.notReadyReasons[surface] = reason;
}

async function readTokens(path: string | undefined, clients: number) {
  if (!path) throw new Error("C2C_LOAD_TOKEN_FILE is required in participant mode.");
  const serialized = await readFile(resolve(path), "utf8");
  const parsed: unknown = JSON.parse(serialized);
  const tokens = tokenFileSchema.parse(parsed);
  if (tokens.length < clients) {
    throw new Error(`The token file has ${tokens.length} tokens for ${clients} clients.`);
  }
  if (new Set(tokens.slice(0, clients)).size !== clients) {
    throw new Error("Participant load testing requires one distinct token per simulated client.");
  }
  return tokens;
}

function syntheticIdea(teamId: string, sequence: number) {
  return [
    "Code2Create load rehearsal only.",
    `Synthetic team ${teamId.slice(-10)} is testing collaborative idea autosave and novelty capacity.`,
    `Revision ${sequence} changes the rehearsal text without describing a real participant project.`,
  ].join(" ");
}

async function runPeriodic(
  deadline: number,
  intervalMs: number,
  initialDelayMs: number,
  task: () => Promise<void>,
) {
  await delay(initialDelayMs);
  while (performance.now() < deadline) {
    await task();
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    await delay(Math.min(intervalMs, remaining));
  }
}

async function measuredWorkloadCall<T>(
  measurements: { attempted: number; errors: number },
  latencies: number[],
  errorSamples: Set<string>,
  task: () => Promise<T>,
) {
  measurements.attempted += 1;
  const startedAt = performance.now();
  try {
    return await task();
  } catch (error) {
    measurements.errors += 1;
    if (errorSamples.size < 5) errorSamples.add(safeErrorMessage(error));
    return null;
  } finally {
    latencies.push(performance.now() - startedAt);
  }
}

async function runIdeaEditingWorkload(
  states: readonly ClientState[],
  configuration: z.infer<typeof configurationSchema>,
  errorSamples: Set<string>,
) {
  const eligibleClients = states.filter((state) => {
    const intake = state.intakeSnapshot;
    return !(
      state.completedAt === null ||
      !intake ||
      intake.application !== null ||
      !intake.draft?.novelty
    );
  });
  const activeParticipantCount = Math.ceil(
    eligibleClients.length * configuration.C2C_LOAD_ACTIVE_PARTICIPANT_PERCENT / 100,
  );
  const activeClients = Array.from({ length: activeParticipantCount }, (_, index) => {
    const selected = eligibleClients[Math.floor(index * eligibleClients.length / activeParticipantCount)];
    if (!selected) throw new Error("The active load-participant selection is incomplete.");
    return selected;
  });
  const allFixtureTeams = new Set(
    eligibleClients.flatMap((state) => state.intakeSnapshot ? [state.intakeSnapshot.teamId] : []),
  );
  const byTeam = new Map<string, ClientState>();
  for (const state of activeClients) {
    const intake = state.intakeSnapshot;
    if (intake && !byTeam.has(intake.teamId)) byTeam.set(intake.teamId, state);
  }
  const editors = [...byTeam.values()];
  if (editors.length === 0) {
    throw new Error(
      "The idea-editing workload needs ready, unsubmitted staging fixture teams with a novelty corpus.",
    );
  }
  const measurements: WorkloadMeasurements = {
    attempted: 0,
    errors: 0,
    heartbeatLatencies: [],
    autosaveLatencies: [],
    noveltyLatencies: [],
    noveltyReady: 0,
    noveltyUnavailable: 0,
  };
  const runId = Date.now().toString(36);
  const deadline = performance.now() + configuration.C2C_LOAD_HOLD_MS;
  const heartbeatIntervalMs = 10_000;
  const heartbeatLoops = activeClients.map((state, activeIndex) =>
    runPeriodic(
      deadline,
      heartbeatIntervalMs,
      Math.floor(activeIndex * heartbeatIntervalMs / activeClients.length),
      async () => {
        await measuredWorkloadCall(
          measurements,
          measurements.heartbeatLatencies,
          errorSamples,
          () => state.client.mutation(api.intakePresence.heartbeat, {
            eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
            surface: "idea",
            sessionId: `load-${runId}-${state.clientIndex}`,
          }),
        );
      },
    )
  );
  const editorLoops = editors.flatMap((state, editorIndex) => {
    const intake = state.intakeSnapshot;
    if (!intake?.draft?.novelty) {
      throw new Error("A selected load editor lost its intake fixture before the workload started.");
    }
    const ideaField = intake.workingFields.find((field) => field.kind === "idea");
    const editor = {
      baseDraftVersion: intake.draft.version,
      corpusVersionId: intake.draft.novelty.corpusVersionId,
      idea: syntheticIdea(intake.teamId, 0),
      ideaSequence: 0,
      noveltySequence: 0,
      revision: ideaField?.revision ?? 0,
      teamId: intake.teamId,
    };
    const offset = (intervalMs: number) => Math.floor(editorIndex * intervalMs / editors.length);
    return [
      runPeriodic(
        deadline,
        configuration.C2C_LOAD_AUTOSAVE_MS,
        offset(configuration.C2C_LOAD_AUTOSAVE_MS),
        async () => {
          editor.ideaSequence += 1;
          editor.idea = syntheticIdea(editor.teamId, editor.ideaSequence);
          const saved = await measuredWorkloadCall(
            measurements,
            measurements.autosaveLatencies,
            errorSamples,
            () => state.client.mutation(api.intake.autosaveWorkingField, {
              eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
              field: { kind: "idea" },
              value: editor.idea,
              baseDraftVersion: editor.baseDraftVersion,
              baseCommittedValue: "",
              expectedRevision: editor.revision,
            }),
          );
          if (saved) editor.revision = saved.revision;
        },
      ),
      runPeriodic(
        deadline,
        configuration.C2C_LOAD_NOVELTY_MS,
        offset(configuration.C2C_LOAD_NOVELTY_MS),
        async () => {
          editor.noveltySequence += 1;
          const result = await measuredWorkloadCall(
            measurements,
            measurements.noveltyLatencies,
            errorSamples,
            () => state.client.action(api.novelty.preview, {
              eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
              corpusVersionId: editor.corpusVersionId,
              idea: editor.idea,
              clientRequestId: `load-${runId}-${state.clientIndex}-${editor.noveltySequence}`,
            }),
          );
          if (result?.state === "ready") measurements.noveltyReady += 1;
          else if (result?.state === "unavailable") measurements.noveltyUnavailable += 1;
        },
      ),
    ];
  });
  await Promise.all([...heartbeatLoops, ...editorLoops]);
  return {
    activeParticipantCount: activeClients.length,
    editorCount: editors.length,
    uniqueFixtureTeams: allFixtureTeams.size,
    measurements,
  };
}

function syntheticIntakeAnswer(ordinal: number) {
  if (ordinal === 1) {
    return "Students who repeatedly run into access problems around a busy campus.";
  }
  if (ordinal === 2) {
    return "They send a short report, and the service routes it to the relevant campus staff.";
  }
  return "The team would keep the next step visible to the student and the responsible staff member.";
}

async function runIntakeBurstWorkload(
  states: readonly ClientState[],
  configuration: z.infer<typeof configurationSchema>,
  errorSamples: Set<string>,
) {
  const allFixtureTeams = new Set(
    states.flatMap((state) => state.intakeSnapshot ? [state.intakeSnapshot.teamId] : []),
  );
  const leadersByTeam = new Map<string, ClientState>();
  for (const state of states) {
    const intake = state.intakeSnapshot;
    if (!intake || intake.currentRole !== "lead") continue;
    if (leadersByTeam.has(intake.teamId)) {
      throw new Error(`The load fixture has more than one active lead for team ${intake.teamId}.`);
    }
    leadersByTeam.set(intake.teamId, state);
  }
  if (leadersByTeam.size !== allFixtureTeams.size) {
    throw new Error(
      `The intake burst needs one authenticated lead for every fixture team (${leadersByTeam.size}/${allFixtureTeams.size}).`,
    );
  }
  const leaders = [...leadersByTeam.values()];
  if (leaders.length === 0) {
    throw new Error("The intake burst needs at least one fresh staging fixture team.");
  }
  for (const leader of leaders) {
    const intake = leader.intakeSnapshot;
    if (!intake || intake.application !== null || intake.draft !== null) {
      throw new Error("The intake burst requires fresh teams without drafts or applications.");
    }
  }

  const measurements: IntakeBurstMeasurements = {
    attempted: 0,
    errors: 0,
    failedTeams: 0,
    fixedQuestions: 0,
    modelQuestions: 0,
    fallbackQuestions: 0,
    modelAssistedTeams: 0,
    teamsReachedReview: 0,
    saveLatencies: [],
    answerLatencies: [],
    adaptiveResolutionLatencies: [],
    teamCompletionLatencies: [],
    maximumModelQuestionsPerTeam: 0,
    teamsWithExactlyTwoFixedQuestions: 0,
  };
  const runId = Date.now().toString(36);

  await Promise.all(leaders.map(async (state, leaderIndex) => {
    const initial = state.intakeSnapshot;
    if (!initial) return;
    await delay(Math.floor(leaderIndex * configuration.C2C_LOAD_RAMP_MS / leaders.length));
    const teamStartedAt = performance.now();
    try {
      const saved = await measuredWorkloadCall(
        measurements,
        measurements.saveLatencies,
        errorSamples,
        () => state.client.mutation(api.intake.saveInitialIdea, {
          eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
          idea: [
            "Campus Relay helps students report recurring access problems to the right staff.",
            `This is disposable load-rehearsal team ${initial.teamId.slice(-10)}.`,
            "Students can see that their report reached someone, but the remaining workflow is still being decided.",
          ].join(" "),
          expectedDraftVersion: 0,
          clientOperationId: `load-${runId}-${state.clientIndex}-idea`,
        }),
      );
      if (!saved) {
        measurements.failedTeams += 1;
        return;
      }
      let snapshot = await waitForIntake(
        state,
        (candidate) => (candidate.draft?.version ?? 0) >= saved.draftVersion,
        10_000,
      );
      let fixedQuestions = 0;
      let modelQuestions = 0;
      let fallbackQuestions = 0;

      for (let step = 0; step < 6; step += 1) {
        const draft = snapshot.draft;
        if (!draft) throw new Error("The saved intake draft disappeared.");
        if (draft.stage === "review") break;
        if (draft.stage === "submitted") {
          throw new Error("A fresh intake fixture was unexpectedly submitted.");
        }
        let active = draft.followUps.find((question) => question.state === "active");
        if (!active) {
          const waitingStartedAt = performance.now();
          snapshot = await waitForIntake(
            state,
            (candidate) => candidate.draft?.stage === "review"
              || candidate.draft?.followUps.some((question) => question.state === "active") === true,
            22_000,
          );
          measurements.adaptiveResolutionLatencies.push(performance.now() - waitingStartedAt);
          if (snapshot.draft?.stage === "review") break;
          active = snapshot.draft?.followUps.find((question) => question.state === "active");
          if (!active) throw new Error("The adaptive intake wait completed without a question or review state.");
        }

        if (active.source === "fixed") fixedQuestions += 1;
        else if (active.source === "model") modelQuestions += 1;
        else fallbackQuestions += 1;
        const draftVersion = snapshot.draft?.version;
        if (draftVersion === undefined) throw new Error("The active follow-up has no draft version.");
        const answered = await measuredWorkloadCall(
          measurements,
          measurements.answerLatencies,
          errorSamples,
          () => state.client.mutation(api.intake.respondToFollowUp, {
            eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
            questionId: active.id,
            answer: syntheticIntakeAnswer(active.ordinal),
            expectedDraftVersion: draftVersion,
            clientOperationId: `load-${runId}-${state.clientIndex}-answer-${active.ordinal}`,
          }),
        );
        if (!answered) {
          measurements.failedTeams += 1;
          return;
        }
        snapshot = await waitForIntake(
          state,
          (candidate) => {
            const nextDraft = candidate.draft;
            return Boolean(
              nextDraft
              && nextDraft.version >= answered.draftVersion
              && (
                nextDraft.stage === "review"
                || nextDraft.followUps.some(
                  (question) => question.state === "active" && question.id !== active.id,
                )
              ),
            );
          },
          22_000,
        );
      }

      measurements.fixedQuestions += fixedQuestions;
      measurements.modelQuestions += modelQuestions;
      measurements.fallbackQuestions += fallbackQuestions;
      if (fixedQuestions === 2) measurements.teamsWithExactlyTwoFixedQuestions += 1;
      if (modelQuestions > 0) measurements.modelAssistedTeams += 1;
      measurements.maximumModelQuestionsPerTeam = Math.max(
        measurements.maximumModelQuestionsPerTeam,
        modelQuestions,
      );
      if (snapshot.draft?.stage === "review") measurements.teamsReachedReview += 1;
      else throw new Error("The intake sequence did not reach review within six questions.");
    } catch (error) {
      measurements.failedTeams += 1;
      if (errorSamples.size < 5) errorSamples.add(safeErrorMessage(error));
    } finally {
      measurements.teamCompletionLatencies.push(performance.now() - teamStartedAt);
    }
  }));

  return { teamCount: leaders.length, measurements };
}

async function main() {
  const configuration = configurationSchema.parse(process.env);
  const endpoint = new URL(configuration.C2C_LOAD_CONVEX_URL);
  const stagingTarget = endpoint.hostname === "localhost"
    || endpoint.hostname === "127.0.0.1"
    || endpoint.hostname.includes("staging");
  if (!stagingTarget) {
    throw new Error("The realtime load driver runs only against localhost or a staging hostname.");
  }
  if (
    configuration.C2C_LOAD_CLIENTS > 250 &&
    configuration.C2C_LOAD_ACKNOWLEDGE !== "code2create-staging" &&
    configuration.C2C_LOAD_ACKNOWLEDGE !== "code2create-staging-writes"
  ) {
    throw new Error(
      "Set C2C_LOAD_ACKNOWLEDGE=code2create-staging before opening more than 250 clients.",
    );
  }
  if (configuration.C2C_LOAD_WORKLOAD !== "subscriptions") {
    if (configuration.C2C_LOAD_MODE !== "participant") {
      throw new Error("Mutating workloads require C2C_LOAD_MODE=participant.");
    }
    if (!configuration.C2C_LOAD_EVENT_SLUG.startsWith("load-")) {
      throw new Error("Mutating workloads run only against a disposable load-* event.");
    }
    if (configuration.C2C_LOAD_ACKNOWLEDGE !== "code2create-staging-writes") {
      throw new Error(
        "Set C2C_LOAD_ACKNOWLEDGE=code2create-staging-writes for the mutating workload.",
      );
    }
  }
  const tokens = configuration.C2C_LOAD_MODE === "participant"
    ? await readTokens(configuration.C2C_LOAD_TOKEN_FILE, configuration.C2C_LOAD_CLIENTS)
    : [];
  const states: ClientState[] = [];
  const errorSamples = new Set<string>();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  let maximumResidentBytes = process.memoryUsage().rss;
  const memoryTimer = setInterval(() => {
    maximumResidentBytes = Math.max(maximumResidentBytes, process.memoryUsage().rss);
  }, 1_000);
  const runStartedAt = performance.now();
  const batchIntervalMs = 100;
  const batchCount = Math.max(1, Math.ceil(configuration.C2C_LOAD_RAMP_MS / batchIntervalMs));
  const clientsPerBatch = Math.max(1, Math.ceil(configuration.C2C_LOAD_CLIENTS / batchCount));

  let ideaEditing: Awaited<ReturnType<typeof runIdeaEditingWorkload>> | null = null;
  let intakeBurst: Awaited<ReturnType<typeof runIntakeBurstWorkload>> | null = null;
  try {
    for (let offset = 0; offset < configuration.C2C_LOAD_CLIENTS; offset += clientsPerBatch) {
      const batchSize = Math.min(clientsPerBatch, configuration.C2C_LOAD_CLIENTS - offset);
      for (let index = 0; index < batchSize; index += 1) {
        const clientIndex = offset + index;
        const client = new ConvexClient(configuration.C2C_LOAD_CONVEX_URL, {
          unsavedChangesWarning: false,
        });
        if (configuration.C2C_LOAD_MODE === "participant") {
          const token = tokens[clientIndex];
          if (!token) throw new Error(`Missing token for client ${clientIndex + 1}.`);
          client.setAuth(async () => token);
        }
        const state: ClientState = {
          client,
          clientIndex,
          completedAt: null,
          errors: 0,
          intakeSnapshot: undefined,
          intakeListeners: new Set(),
          intakeReady: configuration.C2C_LOAD_MODE === "public",
          notReadyReasons: {},
          personId: null,
          profileReady: configuration.C2C_LOAD_MODE === "public",
          publicReady: false,
          startedAt: performance.now(),
          teamId: null,
          teamMaximumSize: null,
          unsubscribe: [],
          updates: 0,
        };
        const onError = (error: Error) => {
          state.errors += 1;
          if (errorSamples.size < 5) errorSamples.add(safeErrorMessage(error));
        };
        state.unsubscribe.push(client.onUpdate(
          api.system.getPublicState,
          { eventSlug: configuration.C2C_LOAD_EVENT_SLUG },
          (publicState) => {
            state.updates += 1;
            if (publicState.event?.slug !== configuration.C2C_LOAD_EVENT_SLUG) {
              state.teamMaximumSize = null;
              markNotReady(state, "public", "The configured load event does not exist.");
              return;
            }
            state.teamMaximumSize = publicState.event.teamMaxSize;
            markReady(state, "public");
          },
          onError,
        ));
        if (configuration.C2C_LOAD_MODE === "participant") {
          state.unsubscribe.push(client.onUpdate(
            api.participants.me,
            { eventSlug: configuration.C2C_LOAD_EVENT_SLUG },
            (participant) => {
              state.updates += 1;
              if (!participant?.membership || participant.profile?.isComplete !== true) {
                state.personId = null;
                markNotReady(
                  state,
                  "profile",
                  "The authenticated load identity is not a fully onboarded participant.",
                );
                return;
              }
              state.personId = participant.person.id;
              markReady(state, "profile");
            },
            onError,
          ));
          state.unsubscribe.push(client.onUpdate(
            api.intake.current,
            { eventSlug: configuration.C2C_LOAD_EVENT_SLUG },
            (intake) => {
              state.intakeSnapshot = intake;
              state.updates += 1;
              for (const listener of state.intakeListeners) listener(intake);
              if (!intake) {
                state.teamId = null;
                markNotReady(
                  state,
                  "intake",
                  "The authenticated load participant does not belong to an intake team.",
                );
                return;
              }
              state.teamId = intake.teamId;
              markReady(state, "intake");
            },
            onError,
          ));
        }
        states.push(state);
      }
      if (states.length < configuration.C2C_LOAD_CLIENTS) await delay(batchIntervalMs);
    }

    const readinessDeadline = performance.now() + configuration.C2C_LOAD_CONNECT_TIMEOUT_MS;
    while (
      performance.now() < readinessDeadline &&
      states.some((state) => state.completedAt === null)
    ) {
      await delay(100);
    }
    for (const state of states) {
      if (state.completedAt !== null) continue;
      for (const reason of Object.values(state.notReadyReasons)) {
        if (errorSamples.size >= 5) break;
        errorSamples.add(reason);
      }
    }
    if (configuration.C2C_LOAD_WORKLOAD === "idea-editing") {
      ideaEditing = await runIdeaEditingWorkload(states, configuration, errorSamples);
    } else if (configuration.C2C_LOAD_WORKLOAD === "intake-burst") {
      intakeBurst = await runIntakeBurstWorkload(states, configuration, errorSamples);
    } else {
      await delay(configuration.C2C_LOAD_HOLD_MS);
    }
  } finally {
    clearInterval(memoryTimer);
    eventLoop.disable();
    await Promise.all(states.map(async (state) => {
      for (const unsubscribe of state.unsubscribe) unsubscribe();
      await state.client.close();
    }));
  }

  const latencies = states
    .flatMap((state) => state.completedAt === null ? [] : [state.completedAt - state.startedAt])
    .toSorted((left, right) => left - right);
  const readyClients = latencies.length;
  const totalErrors = states.reduce((total, state) => total + state.errors, 0);
  const distinctParticipantIds = new Set(
    states.flatMap((state) => state.personId ? [state.personId] : []),
  );
  const teamClientCounts = new Map<string, number>();
  for (const state of states) {
    if (!state.teamId) continue;
    teamClientCounts.set(state.teamId, (teamClientCounts.get(state.teamId) ?? 0) + 1);
  }
  const participantsInTeams = [...teamClientCounts.values()].reduce(
    (total, count) => total + count,
    0,
  );
  const maximumClientsInOneTeam = Math.max(0, ...teamClientCounts.values());
  const configuredTeamMaximum = states.find(
    (state) => state.teamMaximumSize !== null,
  )?.teamMaximumSize ?? null;
  const participantFixturePassed = configuration.C2C_LOAD_MODE === "public" || (
    distinctParticipantIds.size === configuration.C2C_LOAD_CLIENTS
    && participantsInTeams === configuration.C2C_LOAD_CLIENTS
    && teamClientCounts.size > 0
    && configuredTeamMaximum !== null
    && maximumClientsInOneTeam <= configuredTeamMaximum
  );
  const readyRatio = readyClients / configuration.C2C_LOAD_CLIENTS;
  const errorRatio = totalErrors / configuration.C2C_LOAD_CLIENTS;
  const p95 = percentile(latencies, 0.95);
  const p99 = percentile(latencies, 0.99);
  const eventLoopP99Ms = eventLoop.percentile(99) / 1_000_000;
  const ideaEditingErrorRatio = ideaEditing
    ? ideaEditing.measurements.errors / Math.max(1, ideaEditing.measurements.attempted)
    : 0;
  const autosaveP95 = ideaEditing
    ? percentile(ideaEditing.measurements.autosaveLatencies.toSorted((a, b) => a - b), 0.95)
    : null;
  const heartbeatP95 = ideaEditing
    ? percentile(ideaEditing.measurements.heartbeatLatencies.toSorted((a, b) => a - b), 0.95)
    : null;
  const noveltyP99 = ideaEditing
    ? percentile(ideaEditing.measurements.noveltyLatencies.toSorted((a, b) => a - b), 0.99)
    : null;
  const ideaEditingPassed = ideaEditing === null || (
    ideaEditing.measurements.attempted > 0 &&
    ideaEditingErrorRatio <= 0.01 &&
    autosaveP95 !== null &&
    autosaveP95 <= 2_000 &&
    heartbeatP95 !== null &&
    heartbeatP95 <= 2_000 &&
    noveltyP99 !== null &&
    noveltyP99 <= 10_000
  );
  const intakeBurstOperationErrorRatio = intakeBurst
    ? intakeBurst.measurements.errors / Math.max(1, intakeBurst.measurements.attempted)
    : 0;
  const intakeBurstFailedTeamRatio = intakeBurst
    ? intakeBurst.measurements.failedTeams / intakeBurst.teamCount
    : 0;
  const intakeSaveP95 = intakeBurst
    ? percentile(intakeBurst.measurements.saveLatencies.toSorted((a, b) => a - b), 0.95)
    : null;
  const intakeAnswerP95 = intakeBurst
    ? percentile(intakeBurst.measurements.answerLatencies.toSorted((a, b) => a - b), 0.95)
    : null;
  const adaptiveResolutionP99 = intakeBurst
    ? percentile(
        intakeBurst.measurements.adaptiveResolutionLatencies.toSorted((a, b) => a - b),
        0.99,
      )
    : null;
  const intakeCompletionP99 = intakeBurst
    ? percentile(
        intakeBurst.measurements.teamCompletionLatencies.toSorted((a, b) => a - b),
        0.99,
      )
    : null;
  const intakeBurstPassed = intakeBurst === null || (
    intakeBurst.teamCount > 0
    && intakeBurst.measurements.attempted > 0
    && intakeBurstOperationErrorRatio <= 0.01
    && intakeBurstFailedTeamRatio <= 0.01
    && intakeBurst.measurements.teamsReachedReview / intakeBurst.teamCount >= 0.99
    && intakeBurst.measurements.teamsWithExactlyTwoFixedQuestions === intakeBurst.teamCount
    && intakeBurst.measurements.modelQuestions > 0
    && intakeBurst.measurements.maximumModelQuestionsPerTeam <= 2
    && intakeSaveP95 !== null
    && intakeSaveP95 <= 2_000
    && intakeAnswerP95 !== null
    && intakeAnswerP95 <= 2_000
    && adaptiveResolutionP99 !== null
    && adaptiveResolutionP99 <= 21_000
    && intakeCompletionP99 !== null
    && intakeCompletionP99 <= 60_000
  );
  const passed = readyRatio >= 0.995
    && errorRatio <= 0.005
    && p95 !== null
    && p95 <= 5_000
    && p99 !== null
    && p99 <= 10_000
    && eventLoopP99Ms <= 250
    && participantFixturePassed
    && ideaEditingPassed
    && intakeBurstPassed;
  const result = {
    schemaVersion: 3,
    target: endpoint.origin,
    mode: configuration.C2C_LOAD_MODE,
    clients: configuration.C2C_LOAD_CLIENTS,
    rampMs: configuration.C2C_LOAD_RAMP_MS,
    holdMs: configuration.C2C_LOAD_HOLD_MS,
    workload: configuration.C2C_LOAD_WORKLOAD,
    elapsedMs: Math.round(performance.now() - runStartedAt),
    readyClients,
    missingClients: configuration.C2C_LOAD_CLIENTS - readyClients,
    readyPercent: Number((readyRatio * 100).toFixed(3)),
    errors: totalErrors,
    errorPercent: Number((errorRatio * 100).toFixed(3)),
    firstReadyLatencyMs: {
      p50: percentile(latencies, 0.5),
      p95,
      p99,
      maximum: latencies.at(-1) ?? null,
    },
    driver: {
      maximumResidentMiB: Number((maximumResidentBytes / 1_048_576).toFixed(1)),
      eventLoopP99Ms: Number(eventLoopP99Ms.toFixed(1)),
    },
    participantFixture: configuration.C2C_LOAD_MODE === "participant"
      ? {
          distinctIdentities: distinctParticipantIds.size,
          participantsInTeams,
          distinctTeams: teamClientCounts.size,
          maximumClientsInOneTeam,
          configuredTeamMaximum,
          passed: participantFixturePassed,
        }
      : null,
    ideaEditing: ideaEditing
      ? {
          activeParticipantPercent: configuration.C2C_LOAD_ACTIVE_PARTICIPANT_PERCENT,
          activeParticipantCount: ideaEditing.activeParticipantCount,
          editorCount: ideaEditing.editorCount,
          uniqueFixtureTeams: ideaEditing.uniqueFixtureTeams,
          operationsAttempted: ideaEditing.measurements.attempted,
          operationErrors: ideaEditing.measurements.errors,
          operationErrorPercent: Number((ideaEditingErrorRatio * 100).toFixed(3)),
          autosaveLatencyMs: { p95: autosaveP95 },
          heartbeatLatencyMs: { p95: heartbeatP95 },
          noveltyLatencyMs: { p99: noveltyP99 },
          noveltyReady: ideaEditing.measurements.noveltyReady,
          noveltyUnavailable: ideaEditing.measurements.noveltyUnavailable,
          passed: ideaEditingPassed,
        }
      : null,
    intakeBurst: intakeBurst
      ? {
          teams: intakeBurst.teamCount,
          operationsAttempted: intakeBurst.measurements.attempted,
          operationErrors: intakeBurst.measurements.errors,
          operationErrorPercent: Number((intakeBurstOperationErrorRatio * 100).toFixed(3)),
          failedTeams: intakeBurst.measurements.failedTeams,
          failedTeamPercent: Number((intakeBurstFailedTeamRatio * 100).toFixed(3)),
          teamsReachedReview: intakeBurst.measurements.teamsReachedReview,
          teamsWithExactlyTwoFixedQuestions:
            intakeBurst.measurements.teamsWithExactlyTwoFixedQuestions,
          fixedQuestions: intakeBurst.measurements.fixedQuestions,
          modelQuestions: intakeBurst.measurements.modelQuestions,
          fallbackQuestions: intakeBurst.measurements.fallbackQuestions,
          modelAssistedTeams: intakeBurst.measurements.modelAssistedTeams,
          maximumModelQuestionsPerTeam:
            intakeBurst.measurements.maximumModelQuestionsPerTeam,
          saveLatencyMs: { p95: intakeSaveP95 },
          answerLatencyMs: { p95: intakeAnswerP95 },
          adaptiveResolutionLatencyMs: { p99: adaptiveResolutionP99 },
          teamCompletionLatencyMs: { p99: intakeCompletionP99 },
          passed: intakeBurstPassed,
        }
      : null,
    errorSamples: [...errorSamples],
    passed,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}

await main().catch((error: unknown) => {
  process.stderr.write(`${safeErrorMessage(error)}\n`);
  process.exitCode = 1;
});
