import { ReviewQuestions } from "@/components/ReviewQuestions";
import { api } from "@code2create/backend/api";
import type { FunctionReturnType } from "convex/server";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { randomUUID } from "expo-crypto";
import { CameraView, type BarcodeScanningResult,
} from "expo-camera";
import { Stack, useRouter } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState,
} from "react";
import {
  Alert,
  Animated,
  AppState,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Svg, { Path } from "react-native-svg";

import { PagingSetup } from "@/components/PagingSetup";
import { ProjectEvidence } from "@/components/ProjectEvidence";
import { ReviewAvailability } from "@/components/ReviewAvailability";
import { useReviewerSession } from "@/components/ReviewerSession";
import { JudgingSkeleton } from "@/components/skeletons";
import { ReviewerSetup } from "@/components/ReviewerSetup";
import {
  Action,
  ChipRow,
  DutyRing,
  ErrorSheet,
  Field,
  HeaderButton,
  Meta,
  Nothing,
  Problem,
  QuietAction,
  ScoreRow,
  Sheet,
} from "@/components/ui";
import {
  checkEncryptedDraftStorage,
  clearLocalScorecardDraft,
  loadLocalScorecardDraft,
  saveLocalScorecardDraft,
} from "@/lib/local-scorecard";
import {
  clearLocalCoordinatorNotes,
  loadLocalCoordinatorNotes,
  saveLocalCoordinatorNotes,
} from "@/lib/local-coordinator-notes";
import { createLatestDraftWriter } from "@/lib/latest-draft-writer";
import { reviewerPanelMode } from "@/lib/judging-status";
import { useMutationAttempt } from "@/lib/mutation-attempt";
import type { ReviewerPushRegistration } from "@/lib/push-notifications";
import { useCameraAccess } from "@/lib/use-camera-access";
import { useReviewerPush } from "@/lib/use-reviewer-push";
import {
  clearReviewerDevice,
  clearReviewerRegistration,
  createReviewerDevice,
  loadReviewerDevice,
  prepareReviewerRegistration,
  type ReviewerDeviceRecord,
  type ReviewerPlatform,
} from "@/lib/reviewer-device";
import { reviewWorkspaceKey } from "@/lib/review-workspace-key";
import { describeError } from "@/lib/errors";
import {
  confirmObservedClientOperation,
  runPersistentClientOperation,
} from "@/lib/client-operation-intents";
import type { ReviewerRuntime } from "@/lib/runtime";
import { useEstimatedServerNow } from "@/lib/use-estimated-server-now";
import { palette, radius } from "@/theme";

type ReviewerNow = FunctionReturnType<typeof api.reviewer.now>;
type ActiveReview = NonNullable<ReviewerNow["review"]>;
type ReviewerAssignment = NonNullable<ReviewerNow["panel"]> | NonNullable<ReviewerNow["reserve"]>;
type ReviewWorkspaceSnapshot = FunctionReturnType<typeof api.reviewer.reviewWorkspace>;
type ScorecardSnapshot = FunctionReturnType<typeof api.reviewer.scorecard>;
type WorkspaceReview = ActiveReview & ReviewWorkspaceSnapshot & { scorecard: ScorecardSnapshot };
type WorkspaceLoadState =
  | { key: string; value: ReviewWorkspaceSnapshot }
  | { key: string; error: string };
type Rating = ScorecardSnapshot["ratings"][number];
type Criterion = ReviewWorkspaceSnapshot["criteria"][number];
type DeviceState =
  | { status: "loading" }
  | { status: "ready"; record: ReviewerDeviceRecord | null }
  | { status: "error"; message: string };
type NotificationState = { status: "loading" } | ReviewerPushRegistration;
type DraftStorageState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "unavailable"; message: string };
type BusyAction = "create" | "reset" | "register" | "clock_in" | "start" | null;
type CorrectionCategory = "reviewer_error" | "technical_error" | "other";

const scores = [0, 1, 2, 3, 4] as const;

const returnChoices = [5, 10, 15, 20, 30, 45, 60] as const;

export function ReviewPanel({ runtime }: { runtime: ReviewerRuntime }) {
  const eventSlug = runtime.configuration.eventSlug;
  const { reviewHeartbeatIssue } = useReviewerSession();
  const platform = reviewerPlatform();
  const {
    permission: cameraPermission,
    requestPermission: requestCameraPermission,
    error: cameraError,
  } = useCameraAccess();
  const { state: notificationState, requestPermission: requestNotifications } =
    useReviewerPush(runtime.configuration.apnsEnvironment);
  const [draftStorageState, setDraftStorageState] = useState<DraftStorageState>({
    status: "loading",
  },
  );
  const [deviceState, setDeviceState] = useState<DeviceState>(() =>
    platform ? { status: "loading" } : { status: "ready", record: null },
  );
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setErrorState] = useState<{
    message: string;
    raisedWhile: string | undefined;
  } | null>(null);
  const [pagingOpen, setPagingOpen] = useState(false);
  const createBusyRef = useRef(false);
  const clockInAttempt = useMutationAttempt<FunctionReturnType<typeof api.reviewer.clockIn>>();
  const startAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewOperations.startReview>>();
  const router = useRouter();
  const registerDevice = useMutation(api.reviewer.registerDevice);
  const clockIn = useMutation(api.reviewer.clockIn);
  const startReview = useMutation(api.reviewOperations.startReview);
  const loadReviewWorkspace = useAction(api.reviewer.reviewWorkspace);
  const [workspaceLoad, setWorkspaceLoad] = useState<WorkspaceLoadState | null>(null,
  );
  const workspaceRequestRef = useRef<string | null>(null);

  useEffect(() => {
    if (!platform) return;
    let active = true;
    void loadReviewerDevice(eventSlug)
      .then((record) => {
        if (active) setDeviceState({ status: "ready", record });
      })
      .catch(() => {
        if (active) {
          setDeviceState({
            status: "error",
            message: "This phone cannot read its saved reviewer setup.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [eventSlug, platform]);

  useEffect(() => {
    if (!platform) return;
    let active = true;
    void checkEncryptedDraftStorage(eventSlug)
      .then(() => {
        if (active) setDraftStorageState({ status: "ready" });
      })
      .catch(() => {
        if (active) {
          setDraftStorageState({
            status: "unavailable",
            message:
              "Encrypted drafts are unavailable. Install the signed reviewer app before scoring.",
          });
        }
      });
    return () => {
      active = false;
    };
  }, [eventSlug, platform]);

  const deviceRecord = deviceState.status === "ready" ? deviceState.record : null;
  const current = useQuery(
    api.reviewer.now,
    deviceRecord ? { eventSlug, installationId: deviceRecord.installationId } : "skip",
  );
  const reviewSessionId = current?.review?.id;
  const evidenceKey = `${reviewSessionId ?? "none"}:${current?.review?.startedAt ?? "preparation"}`;
  useEffect(() => {
    if (
      !reviewSessionId ||
      workspaceLoad?.key === evidenceKey ||
      workspaceRequestRef.current === evidenceKey
    ) {
      return;
    }
    workspaceRequestRef.current = evidenceKey;
    let active = true;
    void loadReviewWorkspace({ eventSlug, reviewSessionId }).then(
      (value) => {
        if (active) setWorkspaceLoad({ key: evidenceKey, value });
      },
      (caught: unknown) => {
        if (active) {
          setWorkspaceLoad({
            key: evidenceKey,
            error: errorMessage(caught, "The fixed review evidence could not be loaded.",
            ),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [eventSlug, loadReviewWorkspace, reviewSessionId,
    evidenceKey,
    workspaceLoad?.key,
  ]);
  const workspace =
    workspaceLoad && workspaceLoad.key === evidenceKey && "value" in workspaceLoad
      ? workspaceLoad.value
      : null;
  const workspaceError =
    workspaceLoad && workspaceLoad.key === evidenceKey && "error" in workspaceLoad
      ? workspaceLoad.error
      : null;
  const retryWorkspace = () => {
    workspaceRequestRef.current = null;
    setWorkspaceLoad(null);
  };
  const scorecard = useQuery(
    api.reviewer.scorecard,
    reviewSessionId ? { eventSlug, reviewSessionId } : "skip",
  );
  const workspaceReview: WorkspaceReview | null =
    current?.review && workspace && scorecard
      ? { ...current.review, ...workspace, scorecard }
      : null;
  const heartbeatStatus = current?.panel?.clockIn?.status ?? current?.reserve?.clockIn?.status;

  const setError = (message: string | null) => {
    setErrorState(message === null ? null : { message, raisedWhile: heartbeatStatus },
    );
  };
  const visibleError = error && error.raisedWhile === heartbeatStatus ? error.message : null;
  const presenceNeedsRetry =
    current?.review?.status === "awaiting_presence" &&
    !current.review.assignment.reviewerPresenceConfirmed;
  const canClearPresenceOperation = current !== undefined && !presenceNeedsRetry;

  useEffect(() => {
    if (!canClearPresenceOperation) return;
    let active = true;
    void confirmObservedClientOperation({
      eventSlug,
      slot: "review.presence",
    }).catch((caught: unknown) => {
      if (active) {
        setErrorState({
          message: errorMessage(caught, "The saved presence confirmation could not be cleared.",
          ),
          raisedWhile: heartbeatStatus,
        });
      }
    });
    return () => {
      active = false;
    };
  }, [canClearPresenceOperation, eventSlug, heartbeatStatus]);

  const resetReviewerSetup = async () => {
    if (busy) return;
    setBusy("reset");
    try {
      await clearReviewerDevice(eventSlug);
      setDeviceState({ status: "ready", record: null });
    } catch {
      setDeviceState({
        status: "error",
        message: "This phone could not clear its saved setup. Reinstall the reviewer app.",
      });
    } finally {
      setBusy(null);
    }
  };

  if (!platform) {
    return (
      <Panel>
        <Text style={styles.heading}>Project reviews</Text>
        <Text style={styles.body}>Open reviewer mode on an assigned Android phone or iPhone.</Text>
      </Panel>
    );
  }
  if (deviceState.status === "loading") {
    return (
      <Panel>
        <JudgingSkeleton />
      </Panel>
    );
  }
  if (deviceState.status === "error") {
    return (
      <Panel>
        <Text style={styles.heading}>Reviewer setup needs attention</Text>
        <Problem>{deviceState.message}</Problem>
        <Action
          disabled={busy !== null}
          label={busy === "reset" ? "Resetting…" : "Reset reviewer setup"}
          onPress={resetReviewerSetup}
        />
      </Panel>
    );
  }

  const createDevice = async () => {
    if (createBusyRef.current) return;
    createBusyRef.current = true;
    setBusy("create");
    setError(null);
    try {
      const record = await createReviewerDevice(eventSlug, platform);
      setDeviceState({ status: "ready", record });
    } catch (caught) {
      setError(errorMessage(caught, "This phone could not be prepared."));
    } finally {
      createBusyRef.current = false;
      setBusy(null);
    }
  };

  if (!deviceRecord) {
    return (
      <Panel>
        <Text style={styles.heading}>Set up reviewer mode</Text>
        <Text style={styles.body}>
          This creates one installation record for the signed-in reviewer on this phone.
        </Text>
        <Action
          disabled={busy !== null}
          label={busy === "create" ? "Preparing…" : "Set up this phone"}
          onPress={createDevice}
        />
        {error ? <Problem>{error.message}</Problem> : null}
      </Panel>
    );
  }
  if (current === undefined) {
    return (
      <Panel>
        <JudgingSkeleton />
      </Panel>
    );
  }
  const cameraReady = Boolean(cameraPermission?.granted);
  const notificationsReady = notificationState.status === "ready";
  const encryptedDraftReady = draftStorageState.status === "ready";
  const assignment = current.panel ?? current.reserve;
  const round = assignment?.round;
  const checksMeetRound =
    (!round?.requiresCamera || cameraReady) &&
    (!round?.requiresNotifications || notificationsReady) &&
    encryptedDraftReady;
  const deviceIsCurrent =
    current.device?.appBuild === runtime.configuration.appBuild &&
    current.device.cameraReady === cameraReady &&
    current.device.notificationsReady === notificationsReady &&
    current.device.pushTokenFingerprint ===
      (notificationState.status === "ready" ? notificationState.fingerprint : undefined) &&
    current.device.encryptedDraftReady === encryptedDraftReady;
  const panelMode = reviewerPanelMode({
    deviceIsCurrent: deviceIsCurrent && checksMeetRound,
    hasAssignment: assignment !== null && assignment !== undefined,
    hasReview: current.review !== null && current.review !== undefined,
  });

  const saveDeviceRegistration = async () => {
    if (busy) return;
    let attemptedRecord = deviceRecord;
    setBusy("register");
    setError(null);
    try {
      const prepared = await prepareReviewerRegistration(eventSlug, deviceRecord, {
        appBuild: runtime.configuration.appBuild,
        cameraReady,
        ...(notificationState.status === "ready"
          ? {
              push: {
                token: notificationState.token,
                provider: notificationState.provider,
                environment: notificationState.environment,
              },
            }
          : {}),
        encryptedDraftReady,
        expectedVersion: current.device?.version ?? 0,
      },
      );
      attemptedRecord = prepared.record;
      setDeviceState({ status: "ready", record: prepared.record });
      const command = prepared.attempt;
      await registerDevice({
        eventSlug,
        installationId: prepared.record.installationId,
        name: prepared.record.deviceName,
        platform: prepared.record.platform,
        appBuild: command.appBuild,
        cameraReady: command.cameraReady,
        ...(command.push
          ? {
              pushToken: command.push.token,
              pushProvider: command.push.provider,
              pushEnvironment: command.push.environment,
            }
          : {}),
        encryptedDraftReady: command.encryptedDraftReady,
        expectedVersion: command.expectedVersion,
        clientOperationId: command.clientOperationId,
      });
      const nextRecord = await clearReviewerRegistration(
        eventSlug,
        prepared.record,
        command.clientOperationId,
      );
      setDeviceState({ status: "ready", record: nextRecord });
    } catch (caught) {
      if (caught instanceof ConvexError && attemptedRecord.registrationAttempt) {
        const nextRecord = await clearReviewerRegistration(
          eventSlug,
          attemptedRecord,
          attemptedRecord.registrationAttempt.clientOperationId,
        );
        setDeviceState({ status: "ready", record: nextRecord });
      }
      setError(errorMessage(caught, "This phone could not be registered."));
    } finally {
      setBusy(null);
    }
  };

  const clockIntoRound = async () => {
    if (!assignment || busy) return;
    setBusy("clock_in");
    setError(null);
    try {
      await clockInAttempt.run("reviewer-clock-in", () => {
        const args = {
          eventSlug,
          roundId: assignment.round.id,
          installationId: deviceRecord.installationId,
          expectedVersion: assignment.clockIn?.version ?? 0,
          clientOperationId: randomUUID(),
        };
        return () => clockIn(args);
      });
    } catch (caught) {
      setError(errorMessage(caught, "Clock-in could not be completed."));
    } finally {
      setBusy(null);
    }
  };

  const beginReview = async () => {
    if (!current.review || busy) return;
    setBusy("start");
    setError(null);
    try {
      await startAttempt.run("review-start", () => {
        const args = {
          eventSlug,
          reviewSessionId: current.review.id,
          expectedVersion: current.review.version,
          reason: "Panel coordinator started the scheduled review",
          clientOperationId: randomUUID(),
        };
        return () => startReview(args);
      });
    } catch (caught) {
      setError(errorMessage(caught, "The review could not start."));
    } finally {
      setBusy(null);
    }
  };

  if (panelMode === "empty") {
    return (
      <Panel>
        <ReviewAvailability eventSlug={eventSlug} />
        <Nothing>No current review duty</Nothing>
        {visibleError ? <Problem>{visibleError}</Problem> : null}
      </Panel>
    );
  }

  const clockedIn = assignment?.clockIn?.status === "present";
  const review = current.review;
  const everyonePresent = review
    ? review.assignment.reviewerPresenceCount === review.assignment.reviewerCount
    : false;

  const liveScoring = Boolean(
    review &&
    workspaceReview &&
    (review.status === "active" ||
      review.status === "scoring" ||
      workspaceReview.scorecard.status === "correction_open"),
  );

  // One skeleton, not a chain of them: while the workspace for a live review
  // is still on its way, keep showing the same full-screen skeleton the
  // earlier loading states used instead of a heading with a second skeleton.
  if (
    review &&
    !workspaceReview &&
    !workspaceError &&
    (review.status === "active" || review.status === "scoring")
  ) {
    return (
      <Panel>
        <JudgingSkeleton />
      </Panel>
    );
  }

  return (
    <Panel>
      {/* During live scoring the criterion is the page; the round name yields. */}
      {liveScoring ? null : (
        <Text style={styles.heading}>
          {assignment?.round.name ?? review?.round.name ?? "Set up reviewer mode"}
        </Text>
      )}

      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderButton
              label="This phone"
              onPress={() =>
                router.push({
                  pathname: "/duty/reviewer-phone",
                  params: {
                    ...(current.panel ? { panel: current.panel.name } : {}),
                    build: `${runtime.configuration.appBuild}`,
                    camera: cameraReady ? "Ready" : "Not allowed",
                    notifications: notificationLabel(
                      notificationState,
                      current.device?.pushTokenStatus,
                    ),
                    drafts: encryptedDraftReady ? "Ready" : "Unavailable",
                  },
                })
              }
            />
          ),
        }}
      />

      {round?.isPaused ? (
        <View style={styles.pauseNotice}>
          <Text style={styles.value}>New reviews are paused.</Text>
          <Text style={styles.body}>
            Keep this assignment open. A review already underway may continue and finish, but
            another one cannot start yet.
          </Text>
        </View>
      ) : null}

      {panelMode === "setup" ? (
        <ReviewerSetup
          busy={busy !== null || notificationState.status === "loading"}
          cameraReady={cameraReady}
          draftsReady={encryptedDraftReady}
          onOpenPaging={() => setPagingOpen(true)}
          onRegister={saveDeviceRegistration}
          onRequestCamera={async () => {
            await requestCameraPermission();
          }}
          pagingReady={notificationsReady}
          ready={checksMeetRound}
          registerLabel={
            busy === "register"
              ? "Saving…"
              : current.device
                ? "Update this phone"
                : "Register this phone"
          }
        />
      ) : null}

      {deviceIsCurrent && (!notificationsReady || current.device?.pushTokenStatus === "invalid") ? (
        <QuietAction label="Getting paged" onPress={() => setPagingOpen(true)} />
      ) : null}
      <Sheet onClose={() => setPagingOpen(false)} title="Getting paged" visible={pagingOpen}>
        <PagingSetup
          eventSlug={eventSlug}
          onDone={() => setPagingOpen(false)}
          requestPermission={requestNotifications}
          tokenMissing={
            notificationState.status !== "ready" && notificationState.status !== "loading"
          }
          tokenRejected={current.device?.pushTokenStatus === "invalid"}
        />
      </Sheet>

      {cameraError ? <Problem>{cameraError}</Problem> : null}
      {notificationState.status === "unavailable" ? (
        <Problem>{notificationState.message}</Problem>
      ) : null}
      {draftStorageState.status === "unavailable" ? (
        <Problem>{draftStorageState.message}</Problem>
      ) : null}

      {!review ? <ReviewAvailability eventSlug={eventSlug} /> : null}

      {deviceIsCurrent && assignment && !review ? (
        <ClockInControl
          assignment={assignment}
          busy={busy}
          checksMeetRound={checksMeetRound}
          clockedIn={clockedIn}
          current={current}
          onPress={clockIntoRound}
        />
      ) : null}

      {clockedIn && !review ? (
        <View style={styles.waiting}>
          {assignment ? (
            <AvailabilityControl
              eventSlug={eventSlug}
              installationId={deviceRecord.installationId}
              assignment={assignment}
            />
          ) : null}
        </View>
      ) : null}

      {review ? (
        <>
          {liveScoring ? null : <View style={styles.rule} />}
          {workspaceReview ? (
            <ReviewHeading review={workspaceReview} serverNow={current.serverNow} />
          ) : (
            <JudgingSkeleton />
          )}
          {workspaceError ? (
            <View style={styles.waiting}>
              <Problem>{workspaceError}</Problem>
              <QuietAction label="Retry fixed evidence" onPress={retryWorkspace} />
            </View>
          ) : null}
          {review.status === "awaiting_presence" ? (
            <ConflictReport eventSlug={eventSlug} review={review} />
          ) : null}
          {!review.assignment.reviewerPresenceConfirmed && review.status === "awaiting_presence" ? (
            <ReviewQrScanner
              eventSlug={eventSlug}
              installationId={deviceRecord.installationId}
              reviewSessionId={review.id}
            />
          ) : null}
          {review.assignment.reviewerPresenceConfirmed && review.status === "awaiting_presence" ? (
            <View style={styles.waiting}>
              <Text style={styles.value}>Your place is confirmed.</Text>
              <Text style={styles.body}>
                {everyonePresent
                  ? round?.isPaused
                    ? "Every reviewer is here. Wait for operations to resume new starts."
                    : review.assignment.isCoordinator
                      ? "Every reviewer is here. Start when the team is settled."
                      : "Every reviewer is here. The panel coordinator will start."
                  : `${review.assignment.reviewerPresenceCount} of ${review.assignment.reviewerCount} reviewers are confirmed.`}
              </Text>
              {everyonePresent && review.assignment.isCoordinator && !round?.isPaused ? (
                <Action
                  disabled={busy !== null}
                  label={busy === "start" ? "Starting…" : "Start review"}
                  onPress={beginReview}
                />
              ) : null}
            </View>
          ) : null}
          {workspaceReview && (review.status === "active" || review.status === "scoring") ? (
            <ReviewWorkspace
              key={reviewWorkspaceKey(workspaceReview)}
              eventSlug={eventSlug}
              installationId={deviceRecord.installationId}
              review={workspaceReview}
            />
          ) : null}
          {workspaceReview?.scorecard.status === "correction_open" ? (
            <ReviewWorkspace
              key={reviewWorkspaceKey(workspaceReview)}
              eventSlug={eventSlug}
              installationId={deviceRecord.installationId}
              review={workspaceReview}
            />
          ) : null}
        </>
      ) : null}

      {review ? null : <CorrectionRequests eventSlug={eventSlug} />}

      {reviewHeartbeatIssue ? <Problem>{reviewHeartbeatIssue}</Problem> : null}
      <ErrorSheet message={visibleError} onClose={() => setError(null)} />
    </Panel>
  );
}

function CorrectionRequests({ eventSlug }: { eventSlug: string }) {
  const options = useQuery(api.scoreGovernance.myCorrectionOptions, { eventSlug,
  });
  const requestCorrection = useMutation(api.scoreGovernance.requestCorrection);
  const [selectedScorecardId, setSelectedScorecardId] = useState<string | null>(null,
  );
  const [category, setCategory] = useState<CorrectionCategory>("reviewer_error");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.scoreGovernance.requestCorrection>>();
  const requestPending = requestAttempt.hasPending("correction-request");

  if (options === undefined || options.length === 0) return null;

  const submit = async () => {
    const option = options.find((candidate) => candidate.scorecardId === selectedScorecardId,
    );
    if (!option || !option.canRequest || reason.trim().length < 5 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestAttempt.run("correction-request", () => {
        const args = {
          eventSlug,
          scorecardId: option.scorecardId,
          expectedScorecardVersion: option.scorecardVersion,
          category,
          reason,
          clientOperationId: randomUUID(),
        };
        return () => requestCorrection(args);
      });
      setSelectedScorecardId(null);
      setReason("");
    } catch (caught) {
      setError(errorMessage(caught, "The correction request could not be sent."),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Submitted scorecards</Text>
      <Text style={styles.body}>
        A correction changes only your own scorecard and needs operations approval.
      </Text>
      {options.map((option) => {
        const selected = selectedScorecardId === option.scorecardId;
        return (
          <View key={option.scorecardId} style={styles.evidenceRow}>
            <Text style={styles.value}>{option.teamName}</Text>
            <Text style={styles.meta}>{option.roundName}</Text>
            {option.currentCase?.state === "requested" ? (
              <Text style={styles.body}>Correction requested · waiting for operations</Text>
            ) : null}
            {option.currentCase?.state === "rejected" ? (
              <Text style={styles.body}>
                Request declined
                {option.currentCase.decisionReason ? ` · ${option.currentCase.decisionReason}` : ""}
              </Text>
            ) : null}
            {option.currentCase?.state === "closed" ? (
              <Text style={styles.body}>
                The previous correction was submitted and retained in history.
              </Text>
            ) : null}
            {option.canRequest && !selected ? (
              <QuietAction
                label="Request correction"
                onPress={() => {
                  if (!requestPending) {
                    setSelectedScorecardId(option.scorecardId);
                    setCategory("reviewer_error");
                    setReason("");
                  }
                }}
              />
            ) : null}
            {selected ? (
              <View style={styles.availabilityBlock}>
                <Text style={styles.label}>What happened?</Text>
                <ChipRow
                  onSelect={(value: CorrectionCategory) => {
                    if (!requestPending) setCategory(value);
                  }}
                  options={[
                    ["reviewer_error", "My scoring error"],
                    ["technical_error", "Technical issue"],
                    ["other", "Other"],
                  ]}
                  selected={category}
                />
                <TextInput
                  editable={!busy && !requestPending}
                  multiline
                  onChangeText={(value) => {
                    setReason(value);
                  }}
                  placeholder="Briefly explain what needs correction"
                  placeholderTextColor={palette.faint}
                  style={styles.input}
                  value={reason}
                />
                <Action
                  disabled={busy || reason.trim().length < 5}
                  label={busy ? "Sending…" : requestPending ? "Confirm request" : "Send request"}
                  onPress={submit}
                />
                <QuietAction
                  disabled={busy || requestPending}
                  label="Cancel"
                  onPress={() => {
                    setSelectedScorecardId(null);
                    if (!requestPending) setReason("");
                  }}
                />
              </View>
            ) : null}
          </View>
        );
      })}
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function AvailabilityControl({
  eventSlug,
  installationId,
  assignment,
}: {
  eventSlug: string;
  installationId: string;
  assignment: NonNullable<ReviewerNow["panel"]> | NonNullable<ReviewerNow["reserve"]>;
}) {
  const setAvailability = useMutation(api.reviewer.setAvailability);
  const [open, setOpen] = useState(false);
  const [endingShift, setEndingShift] = useState(false);
  const [reason, setReason] = useState("");
  const [returnMinutes, setReturnMinutes] = useState<number>(10);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const availabilityAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewer.setAvailability>>();
  const availabilityPending = availabilityAttempt.hasPending("reviewer-availability",
  );

  const clockIn = assignment.clockIn;
  if (!clockIn) return null;

  const stepAway = async () => {
    const minutes = returnMinutes;
    if (!endingShift && (!Number.isSafeInteger(minutes) || minutes < 1)) {
      setError("Expected return must be a positive whole number of minutes.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await availabilityAttempt.run("reviewer-availability", () => {
        const args = {
          eventSlug,
          roundId: assignment.round.id,
          installationId,
          status: endingShift
            ? ("clocked_out" as const)
            : ("temporarily_unavailable" as const),
          reason,
          ...(endingShift ? {} : { expectedReturnMinutes: minutes }),
          expectedVersion: clockIn.version,
          clientOperationId: randomUUID(),
        };
        return () => setAvailability(args);
      });
    } catch (caught) {
      setError(errorMessage(caught, "Availability could not be changed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <QuietAction label="Change duty status" onPress={() => setOpen(true)} />
      <Sheet onClose={() => setOpen(false)} title={endingShift ? "End my shift" : "Step away"}
        visible={open}
      >
        <ChipRow
          accent={palette.judging}
          selected={endingShift ? "end" : "break"}
          options={[
            ["break", "Short break"],
            ["end", "End shift"],
          ]}
          onSelect={(value) => {
            if (!busy && !availabilityPending) setEndingShift(value === "end");
          }}
        />
        <Text style={styles.label}>Reason</Text>
        <TextInput
          editable={!busy && !availabilityPending}
          onChangeText={(value) => {
            setReason(value);
            setError(null);
          }}
          placeholder="For example: returning after a break"
          placeholderTextColor={palette.faint}
          style={styles.input}
          value={reason}
        />
        {!endingShift ? (
          <>
        <Text style={styles.label}>Expected return in minutes</Text>
        <ChipRow
          accent={palette.judging}
          onSelect={(value) => {
            if (busy || availabilityPending) return;
            setReturnMinutes(Number(value));
            setError(null);
          }}
          options={returnChoices.map((minutes) => [String(minutes), String(minutes)] as const,
              )}
          selected={String(returnMinutes)}
        />
          </>
        ) : null}
        <Action
          disabled={busy || reason.trim().length < 3}
          label={
            busy
              ? "Updating…"
              : availabilityPending
                ? "Confirm earlier update"
                : endingShift
                  ? "Confirm end of shift"
                  : "Confirm step away"
          }
          onPress={stepAway}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </Sheet>
    </>
  );
}

function ConflictReport({ eventSlug, review,
}: { eventSlug: string; review: ActiveReview;
}) {
  const reportConflict = useMutation(api.reviewer.reportConflict);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const conflictAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewer.reportConflict>>();
  const conflictPending = conflictAttempt.hasPending("review-conflict");

  const submit = async () => {
    if (busy || reason.trim().length < 3) return;
    setBusy(true);
    setError(null);
    try {
      await conflictAttempt.run("review-conflict", () => {
        const args = {
          eventSlug,
          reviewSessionId: review.id,
          reason,
          clientOperationId: randomUUID(),
        };
        return () => reportConflict(args);
      });
    } catch (caught) {
      setError(errorMessage(caught, "The conflict could not be reported."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Pressable accessibilityRole="button" onPress={() => setOpen(true)}>
        <Text style={styles.textButton}>I have a conflict with this team</Text>
      </Pressable>
      <Sheet onClose={() => setOpen(false)} title="Report a conflict" visible={open}>
        <Text style={styles.body}>The team returns to the queue for another panel.</Text>
        <TextInput
          editable={!busy && !conflictPending}
          multiline
          onChangeText={(value) => {
            setReason(value);
            setError(null);
          }}
          placeholder="Brief relationship or policy conflict"
          placeholderTextColor={palette.faint}
          style={styles.input}
          value={reason}
        />
        <Action
          destructive
          disabled={busy || reason.trim().length < 3}
          label={
            busy
              ? "Reporting…"
              : conflictPending
                ? "Confirm conflict report"
                : "Report and reroute team"
          }
          onPress={submit}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </Sheet>
    </>
  );
}

function ReviewQrScanner({
  eventSlug,
  installationId,
  reviewSessionId,
}: {
  eventSlug: string;
  installationId: string;
  reviewSessionId: ActiveReview["id"];
}) {
  const { permission, requestPermission } = useCameraAccess();
  const confirmPresence = useMutation(api.reviewer.confirmPresence);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCode, setManualCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const confirm = async (payload: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setScanning(false);
    setError(null);
    try {
      await runPersistentClientOperation({
        eventSlug,
        slot: "review.presence",
        fingerprint: JSON.stringify({
          version: 1,
          reviewSessionId,
          installationId,
        }),
        execute: (clientOperationId) =>
          confirmPresence({
            eventSlug,
            installationId,
            reviewSessionId,
            payload,
            clientOperationId,
          }),
      });
      setManualCode("");
    } catch (caught) {
      setError(errorMessage(caught, "The team code could not be confirmed."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const scan = (result: BarcodeScanningResult) => void confirm(result.data);

  if (manualOpen) {
    return (
      <View style={styles.waiting}>
        <Text style={styles.body}>
          Enter the 12-character fallback code shown beneath the team QR.
        </Text>
        <TextInput
          autoCapitalize="characters"
          autoCorrect={false}
          editable={!busy}
          onChangeText={(value) => {
            setManualCode(value.toUpperCase());
            setError(null);
          }}
          placeholder="ABCD-EFGH-JKLM"
          placeholderTextColor={palette.faint}
          style={styles.codeInput}
          value={manualCode}
        />
        <Action
          disabled={manualCode.replaceAll(/[^A-Z0-9]/g, "").length !== 12 || busy}
          label="Confirm team code"
          onPress={() => confirm(manualCode)}
        />
        <QuietAction label="Cancel" onPress={() => setManualOpen(false)} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }

  if (!permission?.granted) {
    return (
      <View style={styles.waiting}>
        <Text style={styles.body}>
          Camera access is needed to scan the team’s short-lived code.
        </Text>
        <Action
          label="Allow camera"
          onPress={async () => {
            await requestPermission();
          }}
        />
        <QuietAction label="Type code instead" onPress={() => setManualOpen(true)} />
      </View>
    );
  }
  if (!scanning) {
    return (
      <View style={styles.waiting}>
        <Text style={styles.body}>Ask the team to open its current review code.</Text>
        <Action label="Scan team code" onPress={() => setScanning(true)} />
        <QuietAction label="Type code instead" onPress={() => setManualOpen(true)} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    );
  }
  return (
    <View style={styles.scannerBlock}>
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={scan}
        style={styles.camera}
      />
      <QuietAction label="Cancel scan" onPress={() => setScanning(false)} />
    </View>
  );
}

function ClockInControl({
  assignment,
  busy,
  checksMeetRound,
  clockedIn,
  current,
  onPress,
}: {
  assignment: ReviewerAssignment;
  busy: BusyAction;
  checksMeetRound: boolean;
  clockedIn: boolean;
  current: ReviewerNow;
  onPress: () => Promise<void>;
}) {
  const { eventSlug } = useReviewerSession();
  const confirmations = useQuery(api.reviewConfirmations.mine, { eventSlug });
  const estimatedServerNow = useEstimatedServerNow(current.serverNow);
  const confirmation = confirmations?.find(
    (candidate) => candidate.roundId === assignment.round.id,
  );
  const reviewStartsAt = Math.max(
    estimatedServerNow,
    assignment.round.startsAt,
  );
  const confirmedForReview =
    confirmation?.response.status === "confirmed" &&
    confirmation.response.windows.some(
      (window) =>
        window.startsAt <=
          reviewStartsAt + confirmation.assignmentReminderSeconds * 1000 &&
        window.endsAt >=
          Math.max(reviewStartsAt, window.startsAt) +
            confirmation.reviewDurationSeconds * 1_000,
    );
  const clockInOpen =
    estimatedServerNow >= assignment.round.clockInOpensAt &&
    estimatedServerNow < assignment.round.endsAt;
  return (
    <View style={styles.waiting}>
      {!clockedIn ? (
        <Text style={styles.meta}>
          Report {formatDeviceTime(assignment.round.reviewerReportAt)} · clock-in opens {formatDeviceTime(assignment.round.clockInOpensAt)}
        </Text>
      ) : null}
      <DutyRing
        accent={palette.judging}
        busy={busy === "clock_in"}
        {...(clockedIn ? { detail: dutyStateDetail(current) } : {})}
        disabled={busy !== null || !checksMeetRound ||
          !confirmedForReview ||
          (!clockedIn && !clockInOpen)}
        label={clockedIn ? "On duty" : assignment.clockIn ? "Return to duty" : "Clock in"}
        on={clockedIn}
        onPress={onPress}
      />
      {!confirmedForReview ? (
        <Text style={styles.meta}>
          Confirm hours covering your next review before clocking in.
        </Text>
      ) : null}
    </View>
  );
}

function ReviewHeading({ review, serverNow,
}: { review: WorkspaceReview; serverNow: number;
}) {
  const scoring =
    review.status === "active" ||
    review.status === "scoring" ||
    review.scorecard.status === "correction_open";
  if (scoring) {
    return (
      <View style={styles.contextBar}>
        <View style={styles.contextText}>
          <Text numberOfLines={1} style={styles.contextTeam}>
            {review.team.name}
          </Text>
          <Text numberOfLines={1} style={styles.contextDetail}>
            Submitted project
          </Text>
        </View>
        {review.plannedEndAt ? (
          <ReviewClock
            key={serverNow}
            discussionEnded={review.status === "scoring"}
            plannedEndAt={review.plannedEndAt}
            serverNow={serverNow}
          />
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.reviewHeading}>
      <Text style={styles.reviewTitle}>{review.team.name}</Text>
    </View>
  );
}

function ReviewClock({
  plannedEndAt,
  serverNow,
  discussionEnded,
}: {
  plannedEndAt: number;
  serverNow: number;
  discussionEnded: boolean;
}) {
  const estimatedServerNow = useEstimatedServerNow(serverNow);
  const remainingSeconds = Math.ceil((plannedEndAt - estimatedServerNow) / 1_000,
  );
  const absoluteSeconds = Math.max(0, remainingSeconds);
  const hours = Math.floor(absoluteSeconds / 3_600);
  const minutes = Math.floor((absoluteSeconds % 3_600) / 60);
  const seconds = absoluteSeconds % 60;
  const display =
    hours > 0
      ? `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
      : `${minutes}:${seconds.toString().padStart(2, "0")}`;
  const late = discussionEnded || remainingSeconds <= 0;
  return (
    <View style={styles.clockChip}>
      <Text style={[styles.clockText, late ? styles.clockLate : null]}>
        {late ? "Finish scores" : display}
      </Text>
    </View>
  );
}

function ReviewDiscussionControls({
  eventSlug,
  review,
}: {
  eventSlug: string;
  review: WorkspaceReview;
}) {
  const end = useMutation(api.reviewOperations.endDiscussion);
  const attempt = useMutationAttempt<
    FunctionReturnType<typeof api.reviewOperations.endDiscussion>
  >();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isDiscussion = review.status === "active";
  if (
    !review.assignment.isCoordinator ||
    review.scorecard.status === "correction_open"
  )
    return null;
  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await attempt.run("review-phase", () => {
        const args = {
          eventSlug,
          reviewSessionId: review.id,
          expectedVersion: review.version,
          clientOperationId: randomUUID(),
        };
        return () => end(args);
      });
    } catch (caught) {
      setError(errorMessage(caught, "The review changed. Please try again."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.waiting}>
      <Text style={styles.meta}>
        {isDiscussion
          ? "End the discussion when the team has finished. Everyone can then submit their scores and final comments."
          : `Discussion finished · ${review.submittedScorecardCount} of ${review.assignment.reviewerCount} scorecards submitted`}
      </Text>
      {isDiscussion ? (
        <QuietAction
          disabled={busy}
          label={
            busy
              ? "Saving…"
              : attempt.hasPending("review-phase")
                ? "Retry review update"
                : "End discussion"
          }
          onPress={() => void run()}
        />
      ) : null}
      {error ? <Problem>{error}</Problem> : null}
    </View>
  );
}

function ReviewWorkspace({
  eventSlug,
  installationId,
  review,
}: {
  eventSlug: string;
  installationId: string;
  review: WorkspaceReview;
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  return (
    <View style={styles.workspace}>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={() => setEvidenceOpen(true)}
        style={({ pressed }) => [styles.evidenceLink, pressed ? styles.disabled : null,
        ]}
      >
        <Text style={styles.evidenceLinkText}>Project details</Text>
        <Text style={styles.evidenceLinkChevron}>›</Text>
      </Pressable>
      <ReviewQuestions eventSlug={eventSlug} reviewSessionId={review.id} />
      <ReviewDiscussionControls eventSlug={eventSlug} review={review} />
      <ScorecardEditor eventSlug={eventSlug} installationId={installationId} review={review} />
      {review.assignment.isCoordinator && review.scorecard.status !== "correction_open" ? (
        <CoordinatorNotes eventSlug={eventSlug} review={review} />
      ) : null}
      {review.scorecard.status === "submitted" && review.assignment.completionReady ? (
        <ReviewCompletion eventSlug={eventSlug} review={review} />
      ) : null}
      <Sheet onClose={() => setEvidenceOpen(false)} title="Project details" visible={evidenceOpen}>
        <ScrollView showsVerticalScrollIndicator={false} style={styles.evidenceSheet}>
          <ProjectEvidence eventSlug={eventSlug} review={review} />
        </ScrollView>
      </Sheet>
    </View>
  );
}

function ReviewCompletion({ eventSlug, review }: { eventSlug: string; review: WorkspaceReview }) {
  const completeReview = useMutation(api.reviewOperations.completeReview);
  const completeAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewOperations.completeReview>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await completeAttempt.run("review-complete", () => {
        const args = {
          eventSlug,
          reviewSessionId: review.id,
          expectedVersion: review.version,
          reason: "Completed in the reviewer app after every panel scorecard was submitted",
          clientOperationId: randomUUID(),
        };
        return () => completeReview(args);
      });
    } catch (caught) {
      setError(errorMessage(caught, "The review could not be completed."));
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    Alert.alert(
      "Complete review?",
      "Every panel scorecard is submitted. This ends the review for the whole panel and makes everyone ready for the next team.",
      [
        { text: "Not yet", style: "cancel" },
        { text: "Complete review", style: "destructive", onPress: () => void complete() },
      ],
    );
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Panel finished</Text>
      <Text style={styles.body}>
        All {review.assignment.reviewerCount} panel scorecards are submitted. Any reviewer can
        close this review.
      </Text>
      <Action
        disabled={busy}
        label={
          busy
            ? "Completing…"
            : completeAttempt.hasPending("review-complete")
              ? "Retry completion"
              : "Complete review"
        }
        onPress={confirm}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function CoordinatorNotes({ eventSlug, review }: { eventSlug: string; review: WorkspaceReview }) {
  const saveSharedNotes = useMutation(api.reviewOperations.saveSharedNotes);
  const [initialNotes] = useState(() => ({
    reviewSessionId: review.id,
    serverNotesVersion: review.sharedNotesVersion,
    findings: review.sharedFindings ?? "",
    commitments: review.sharedCommitments ?? "",
  }));
  const [findings, setFindings] = useState(review.sharedFindings ?? "");
  const [commitments, setCommitments] = useState(review.sharedCommitments ?? "",
  );
  const [notesVersion, setNotesVersion] = useState(review.sharedNotesVersion);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localState, setLocalState] = useState<"loading" | "ready" | "restored">("loading");
  const editRevisionRef = useRef(0);
  const mountedRef = useRef(true);
  const saveAttempt = useMutationAttempt<{ sharedNotesVersion: number; editRevision: number;
  }>();
  const [localDraftWriter] = useState(() => createLatestDraftWriter(saveLocalCoordinatorNotes),
  );
  const effectiveNotesVersion = Math.max(notesVersion, review.sharedNotesVersion,
  );

  useLayoutEffect(() => {
    localDraftWriter.update(
      dirty && localState !== "loading"
        ? {
            eventSlug,
            reviewSessionId: review.id,
            serverNotesVersion: effectiveNotesVersion,
            findings,
            commitments,
          }
        : null,
    );
  }, [
    commitments,
    dirty,
    effectiveNotesVersion,
    eventSlug,
    findings,
    localDraftWriter,
    localState,
    review.id,
  ]);

  const persistLocalNotes = useCallback(() => {
    return localDraftWriter.flush().then(
      () => {
        if (mountedRef.current) setLocalError(null);
      },
      (caught: unknown) => {
        if (mountedRef.current) {
          setLocalError(errorMessage(caught, "The encrypted panel notes could not be updated.",
            ),
          );
        }
      },
    );
  }, [localDraftWriter]);

  useEffect(() => {
    let active = true;
    void loadLocalCoordinatorNotes(eventSlug, initialNotes.reviewSessionId)
      .then((stored) => {
        if (!active) return;
        if (stored) {
          setFindings(stored.findings);
          setCommitments(stored.commitments);
          setNotesVersion(Math.max(stored.serverNotesVersion, initialNotes.serverNotesVersion,
            ),
          );
          editRevisionRef.current += 1;
          setDirty(true);
          setLocalState("restored");
          return;
        }
        setLocalState("ready");
      })
      .catch((caught: unknown) => {
        if (!active) return;
        setLocalError(errorMessage(caught, "Encrypted panel-note storage is unavailable."),
        );
        setLocalState("ready");
      });
    return () => {
      active = false;
    };
  }, [eventSlug, initialNotes]);

  useEffect(() => {
    if (!dirty || localState === "loading") return;
    const timer = setTimeout(() => void persistLocalNotes(), 250);
    return () => clearTimeout(timer);
  }, [commitments, dirty, effectiveNotesVersion, findings, localState, persistLocalNotes,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void persistLocalNotes();
    });
    return () => {
      void persistLocalNotes();
      mountedRef.current = false;
      subscription.remove();
    };
  }, [persistLocalNotes]);

  const edit = () => {
    editRevisionRef.current += 1;
    setDirty(true);
    setError(null);
  };

  const save = async () => {
    if (busy || !findings.trim() || !commitments.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await saveAttempt.run("shared-notes-save", () => {
        const editRevision = editRevisionRef.current;
        const args = {
          eventSlug,
          reviewSessionId: review.id,
          findings,
          commitments,
          expectedNotesVersion: effectiveNotesVersion,
          clientOperationId: randomUUID(),
        };
        return async () => ({
          ...(await saveSharedNotes(args)),
          editRevision,
        });
      });
      setNotesVersion(result.sharedNotesVersion);
      if (result.editRevision === editRevisionRef.current) {
        localDraftWriter.update(null);
        setDirty(false);
        try {
          await clearLocalCoordinatorNotes(eventSlug, review.id);
          setLocalError(null);
        } catch (caught) {
          setLocalError(errorMessage(caught, "The saved local panel notes could not be cleared.",
            ),
          );
        }
      } else {
        setError(
          "The earlier panel notes were confirmed. Your newer edits are still here; save again.",
        );
      }
    } catch (caught) {
      setError(errorMessage(caught, "The shared notes could not be saved."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Panel notes</Text>
      {localError ? <Problem>{localError}</Problem> : null}
      <Text style={styles.label}>What did the panel observe?</Text>
      <TextInput
        editable={!busy}
        multiline
        onChangeText={(value) => {
          setFindings(value);
          edit();
        }}
        placeholder="A short factual summary"
        placeholderTextColor={palette.faint}
        style={styles.input}
        value={findings}
      />
      <Text style={styles.label}>What should the team show next?</Text>
      <TextInput
        editable={!busy}
        multiline
        onChangeText={(value) => {
          setCommitments(value);
          edit();
        }}
        placeholder="Concrete next-checkpoint commitments"
        placeholderTextColor={palette.faint}
        style={styles.input}
        value={commitments}
      />
      <QuietAction
        disabled={
          busy || localState === "loading" || !dirty || !findings.trim() || !commitments.trim()
        }
        label={busy ? "Saving…" : dirty ? "Save panel notes" : "Panel notes saved"}
        onPress={save}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

function ScorecardEditor({
  eventSlug,
  installationId,
  review,
}: {
  eventSlug: string;
  installationId: string;
  review: WorkspaceReview;
}) {
  const saveScorecardDraft = useMutation(api.reviewer.saveDraft);
  const submitScorecard = useMutation(api.reviewer.submitScorecard);
  const [initialDraft] = useState(() => ({
    scorecardId: review.scorecard.id,
    serverDraftVersion: review.scorecard.draftVersion,
    criteria: review.criteria,
    submitted: review.scorecard.status === "submitted",
  }));
  const [ratings, setRatings] = useState<Rating[]>(review.scorecard.ratings);
  // One criterion per step; the step past the last criterion is the summary.
  const [step, setStep] = useState(() =>
    firstUnratedStep(review.criteria, review.scorecard.ratings),
  );
  const [privateNote, setPrivateNote] = useState(review.scorecard.privateNote ?? "",
  );
  const [finalComment, setFinalComment] = useState(
    review.scorecard.finalComment ?? "",
  );
  const [draftVersion, setDraftVersion] = useState(review.scorecard.draftVersion,
  );
  const [dirty, setDirty] = useState(false);
  const [submitted, setSubmitted] = useState(review.scorecard.status === "submitted",
  );
  const [busy, setBusy] = useState<"save" | "submit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localState, setLocalState] = useState<"loading" | "ready" | "restored">("loading");
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitUncertain, setSubmitUncertain] = useState(false);
  const [submitFailed, setSubmitFailed] = useState(false);
  const editRevisionRef = useRef(0);
  const saveAttempt = useMutationAttempt<{ draftVersion: number; editRevision: number;
  }>();
  const submitAttempt =
    useMutationAttempt<FunctionReturnType<typeof api.reviewer.submitScorecard>>();
  const [localDraftWriter] = useState(() => createLatestDraftWriter(saveLocalScorecardDraft),
  );
  const mountedRef = useRef(true);
  const effectiveDraftVersion = Math.max(draftVersion, review.scorecard.draftVersion,
  );

  useLayoutEffect(() => {
    localDraftWriter.update(
      dirty && localState !== "loading" && !submitted
        ? {
            eventSlug,
            scorecardId: review.scorecard.id,
            serverDraftVersion: effectiveDraftVersion,
            ratings: ratings.map((rating) => ({
              criterionId: rating.criterionId,
              score: rating.score,
              ...(rating.evidenceNote !== undefined ? { evidenceNote: rating.evidenceNote } : {}),
            })),
            privateNote,
            finalComment,
          }
        : null,
    );
  }, [
    dirty,
    effectiveDraftVersion,
    eventSlug,
    localDraftWriter,
    localState,
    privateNote,
    finalComment,
    ratings,
    review.scorecard.id,
    submitted,
  ]);

  const persistLocalDraft = useCallback(() => {
    return localDraftWriter.flush().then(
      () => {
        if (mountedRef.current) setLocalError(null);
      },
      (caught: unknown) => {
        if (mountedRef.current) {
          setLocalError(errorMessage(caught, "The encrypted local draft could not be updated.",
            ),
          );
        }
      },
    );
  }, [localDraftWriter]);

  useEffect(() => {
    let active = true;
    const restore = async () => {
      try {
        const stored = await loadLocalScorecardDraft(eventSlug, initialDraft.scorecardId,
        );
        if (!active) return;
        if (initialDraft.submitted) {
          await clearLocalScorecardDraft(eventSlug, initialDraft.scorecardId);
          if (active) setLocalState("ready");
          return;
        }
        if (stored) {
          const restoredRatings: Rating[] = stored.ratings.flatMap((storedRating) => {
            const criterion = initialDraft.criteria.find(
              (candidate) => candidate.id === storedRating.criterionId,
            );
            if (!criterion) return [];
            return [
              {
                criterionId: criterion.id,
                score: storedRating.score,
                ...(storedRating.evidenceNote !== undefined
                  ? { evidenceNote: storedRating.evidenceNote }
                  : {}),
              },
            ];
          },
          );
          setRatings(restoredRatings);
          setStep(firstUnratedStep(initialDraft.criteria, restoredRatings));
          setPrivateNote(stored.privateNote);
          setFinalComment(stored.finalComment);
          setDraftVersion(Math.max(stored.serverDraftVersion, initialDraft.serverDraftVersion,
            ),
          );
          editRevisionRef.current += 1;
          setDirty(true);
          setLocalState("restored");
          return;
        }
        if (active) setLocalState("ready");
      } catch (caught) {
        if (!active) return;
        setLocalError(errorMessage(caught, "Encrypted local draft storage is unavailable."),
        );
        setLocalState("ready");
      }
    };
    void restore();
    return () => {
      active = false;
    };
  }, [eventSlug, initialDraft]);

  useEffect(() => {
    if (!dirty || localState === "loading" || submitted) return;
    const timer = setTimeout(() => {
      void persistLocalDraft();
    }, 250);
    return () => clearTimeout(timer);
  }, [
    dirty,
    effectiveDraftVersion,
    eventSlug,
    localState,
    persistLocalDraft,
    privateNote,
    finalComment,
    ratings,
    review.scorecard.id,
    submitted,
  ]);

  useEffect(() => {
    mountedRef.current = true;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") void persistLocalDraft();
    });
    return () => {
      void persistLocalDraft();
      mountedRef.current = false;
      subscription.remove();
    };
  }, [persistLocalDraft]);

  // The server draft keeps itself current: a beat after the last edit, the
  // scores go up without a save button. A phone that dies mid-review hands
  // the draft to whichever device the reviewer signs into next.
  const saveRef = useRef<() => Promise<number | null>>(async () => null);
  useEffect(() => {
    if (!dirty || submitted || submitUncertain || localState === "loading" || busy !== null) return;
    const timer = setTimeout(() => {
      void saveRef.current();
    }, 1_200);
    return () => clearTimeout(timer);
  }, [busy, dirty, localState, privateNote,
    finalComment,
    ratings,
    submitUncertain,
    submitted,
  ]);

  const edit = () => {
    editRevisionRef.current += 1;
    setDirty(true);
    setError(null);
  };

  const setScore = (criterionId: Criterion["id"], score: number) => {
    setRatings((current) => {
      const existing = current.find((rating) => rating.criterionId === criterionId,
      );
      if (!existing) return [...current, { criterionId, score }];
      return current.map((rating) =>
        rating.criterionId === criterionId ? { ...rating, score } : rating,
      );
    });
    edit();
  };

  const setEvidenceNote = (criterionId: Criterion["id"], evidenceNote: string,
  ) => {
    setRatings((current) =>
      current.map((rating) =>
        rating.criterionId === criterionId ? { ...rating, evidenceNote } : rating,
      ),
    );
    edit();
  };

  const save = async () => {
    if (busy) return null;
    setBusy("save");
    setError(null);
    try {
      const result = await saveAttempt.run("scorecard-draft-save", () => {
        const editRevision = editRevisionRef.current;
        const args = {
          eventSlug,
          installationId,
          scorecardId: review.scorecard.id,
          ratings: ratings.map((rating) => ({ ...rating })),
          ...(privateNote.trim() ? { privateNote } : {}),
          ...(finalComment.trim() ? { finalComment } : {}),
          expectedDraftVersion: effectiveDraftVersion,
          clientOperationId: randomUUID(),
        };
        return async () => ({
          ...(await saveScorecardDraft(args)),
          editRevision,
        });
      });
      setDraftVersion(result.draftVersion);
      if (result.editRevision === editRevisionRef.current) {
        localDraftWriter.update(null);
        setDirty(false);
        try {
          await clearLocalScorecardDraft(eventSlug, review.scorecard.id);
          setLocalError(null);
        } catch (caught) {
          setLocalError(errorMessage(caught, "The saved local draft could not be cleared."),
          );
        }
        return result.draftVersion;
      }
      // Edits landed while this save was in flight; dirty stays true and the
      // autosave loop simply carries them on the next pass.
      return null;
    } catch (caught) {
      setError(errorMessage(caught, "The draft could not be saved."));
      return null;
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    saveRef.current = save;
  });

  const submit = async (expectedDraftVersion: number) => {
    if (busy) return;
    setBusy("submit");
    setError(null);
    setSubmitFailed(false);
    try {
      await submitAttempt.run("scorecard-submit", () => {
        const args = {
          eventSlug,
          installationId,
          scorecardId: review.scorecard.id,
          expectedDraftVersion,
          clientOperationId: randomUUID(),
        };
        return () => submitScorecard(args);
      });
      localDraftWriter.update(null);
      setSubmitted(true);
      setSubmitUncertain(false);
      try {
        await clearLocalScorecardDraft(eventSlug, review.scorecard.id);
        setLocalError(null);
      } catch (caught) {
        setLocalError(errorMessage(caught, "The submitted local draft could not be cleared.",
          ),
        );
      }
    } catch (caught) {
      setSubmitUncertain(!(caught instanceof ConvexError));
      setSubmitFailed(true);
      setError(errorMessage(caught, "The scorecard could not be submitted."));
    } finally {
      setBusy(null);
    }
  };

  const prepareSubmission = async () => {
    if (submitUncertain) {
      await submit(effectiveDraftVersion);
      return;
    }
    const problem = submissionProblem(review.criteria, ratings) ??
      (review.scorecard.requiresFinalComment && finalComment.trim().length < 3
        ? "Leave a final comment about the review before submitting."
        : null);
    if (problem) {
      setError(problem);
      return;
    }
    const version = dirty ? await save() : effectiveDraftVersion;
    if (version === null) return;
    Alert.alert(
      "Submit scorecard?",
      "Your scores become fixed. Only an audited correction opened by operations can change them.",
      [
        { text: "Keep editing", style: "cancel" },
        { text: "Submit", style: "destructive", onPress: () => void submit(version),
        },
      ],
    );
  };

  if (submitted) {
    return (
      <View style={styles.outcome}>
        <DrawnMark kind="check" />
        <Text style={styles.outcomeTitle}>Scorecard submitted</Text>
        <Text style={styles.outcomeBody}>
          Your scores are locked, and stay yours alone until release.
        </Text>
        <Text style={styles.outcomeNext}>
          {review.assignment.reviewerCount > 1
            ? "When the rest of the panel has submitted, the next review takes over this screen on its own."
            : "The next review takes over this screen on its own."}
        </Text>
      </View>
    );
  }

  const correcting = review.scorecard.status === "correction_open";
  // A background save must never lock the inputs; only submitting does.
  const locked = busy === "submit" || localState === "loading" || submitUncertain;
  const summaryStep = review.criteria.length;
  const criterion = step < summaryStep ? review.criteria[step] : undefined;
  const rating = criterion
    ? ratings.find((candidate) => candidate.criterionId === criterion.id)
    : undefined;
  const stepNoteMissing =
    rating !== undefined &&
    (rating.score === 0 || rating.score === 4) &&
    (!rating.evidenceNote || rating.evidenceNote.trim().length < 3);

  return (
    <View style={styles.scorecard}>
      <View style={styles.stepMeter}>
        {review.criteria.map((candidate, index) => {
          const rated = ratings.some((entry) => entry.criterionId === candidate.id,
          );
          return (
            <Pressable
              hitSlop={8}
              key={candidate.id}
              onPress={() => setStep(index)}
              style={[
                styles.stepSegment,
                index === step ? styles.stepSegmentCurrent : null,
                rated ? styles.stepSegmentDone : null,
              ]}
            />
          );
        })}
      </View>
      {localError ? <Problem>{localError}</Problem> : null}

      {criterion ? (
        <View style={styles.criterion}>
          <Meta>
            {`${correcting ? "Correction · " : ""}${step + 1} of ${review.criteria.length}`}
          </Meta>
          <Text style={styles.criterionLabel}>{criterion.label}</Text>
          <Text style={styles.criterionQuestion}>{criterion.question}</Text>
          <ScoreRow
            accent={palette.text}
            disabled={locked}
            ink={palette.background}
            onSelect={(score) => setScore(criterion.id, score)}
            scores={scores}
            selected={rating?.score}
          />
          <Text style={styles.anchor}>
            {rating ? anchorText(criterion, rating.score) : criterion.guidance}
          </Text>
          {rating ? (
            <Field
              editable={!locked}
              label={
                rating.score === 0 || rating.score === 4
                  ? "Why this score (required)"
                  : "Note (optional)"
              }
              multiline
              onChangeText={(value) => setEvidenceNote(criterion.id, value)}
              placeholder="What you saw."
              value={rating.evidenceNote ?? ""}
            />
          ) : null}
          {error ? <Problem>{error}</Problem> : null}
          <View style={styles.stepDock}>
            <Action
              disabled={rating === undefined || stepNoteMissing || localState === "loading"}
              label={step + 1 === summaryStep ? "Review scores" : "Next"}
              onPress={() => setStep(step + 1)}
            />
            {step > 0 ? (
              <QuietAction label="Back" onPress={() => setStep(step - 1)} />
            ) : null}
          </View>
        </View>
      ) : (
        <View style={styles.criterion}>
          <Meta>Every score, before it locks</Meta>
          <View>
            {review.criteria.map((candidate, index) => {
              const entry = ratings.find((found) => found.criterionId === candidate.id,
              );
              return (
                <Pressable
                  key={candidate.id}
                  onPress={() => setStep(index)}
                  style={({ pressed }) => [
                    styles.summaryRow,
                    index > 0 ? styles.summaryRowRule : null,
                    pressed ? styles.summaryPressed : null,
                  ]}
                >
                  <Text style={styles.summaryLabel}>{candidate.label}</Text>
                  <Text style={entry ? styles.summaryScore : styles.summaryMissing}>
                    {entry ? entry.score : "—"}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Field
            editable={!locked}
            label={
              review.scorecard.requiresFinalComment
                ? "Final comment (required)"
                : "Final comment"
            }
            maxLength={2_000}
            multiline
            onChangeText={(value) => {
              setFinalComment(value);
              edit();
            }}
            placeholder="What worked, what needs improvement, and your main takeaway."
            value={finalComment}
          />

          <Field
            editable={!locked}
            label="Private note"
            multiline
            onChangeText={(value) => {
              setPrivateNote(value);
              edit();
            }}
            placeholder="Only ever visible on your own scorecard."
            value={privateNote}
          />

          {submitFailed && error ? (
            <View style={styles.failBlock}>
              <DrawnMark kind="cross" size={44} />
              <View style={styles.failText}>
                <Text style={styles.failTitle}>Not submitted</Text>
                <Text style={styles.error}>{error}</Text>
              </View>
            </View>
          ) : error ? (
            <Problem>{error}</Problem>
          ) : null}
          <Action
            disabled={busy === "submit" || localState === "loading" ||
              review.status === "active"
            }
            label={
              busy === "submit"
                ? "Submitting…"
                : submitUncertain
                  ? "Confirm submission"
                  : review.status === "active"
                    ? "Submit after discussion"
                    : "Submit scorecard"
            }
            onPress={prepareSubmission}
          />
        </View>
      )}
    </View>
  );
}

const AnimatedPath = Animated.createAnimatedComponent(Path);
const drawnMarkPaths = {
  check: { d: "M6 12.5l4.2 4.2L18 8", length: 18 },
  cross: { d: "M8 8l8 8M16 8l-8 8", length: 24 },
} as const;

/** A verdict disc that springs in, then draws its stroke. */
function DrawnMark({ kind, size = 84,
}: { kind: "check" | "cross"; size?: number;
}) {
  const [pop] = useState(() => new Animated.Value(0));
  const [draw] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.spring(pop, {
      toValue: 1,
      damping: 13,
      mass: 0.7,
      stiffness: 180,
      useNativeDriver: true,
    }).start();
    // SVG stroke props animate on the JS driver only.
    Animated.timing(draw, {
      toValue: 1,
      delay: 160,
      duration: 420,
      useNativeDriver: false,
    }).start();
  }, [draw, pop]);

  const mark = drawnMarkPaths[kind];
  return (
    <Animated.View
      style={[
        styles.drawnDisc,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: kind === "check" ? palette.judging : palette.urgent,
          opacity: pop,
          transform: [{ scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1],
              }),
            },
          ],
        },
      ]}
    >
      <Svg fill="none" height={size * 0.58} viewBox="0 0 24 24" width={size * 0.58}>
        <AnimatedPath
          d={mark.d}
          stroke={kind === "check" ? palette.onJudging : palette.onUrgent}
          strokeDasharray={mark.length}
          strokeDashoffset={draw.interpolate({ inputRange: [0, 1], outputRange: [mark.length, 0],
          })}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2.6}
        />
      </Svg>
    </Animated.View>
  );
}

/** The step to open on: the first unscored criterion, or the summary. */
function firstUnratedStep(criteria: Criterion[], ratings: Rating[]) {
  const gap = criteria.findIndex(
    (criterion) => !ratings.some((rating) => rating.criterionId === criterion.id),
  );
  return gap === -1 ? criteria.length : gap;
}

function Panel({ children }: { children: React.ReactNode }) {
  return <View style={styles.panel}>{children}</View>;
}

function reviewerPlatform(): ReviewerPlatform | null {
  if (Platform.OS === "android") return "android";
  if (Platform.OS === "ios") return "ios";
  return null;
}

function formatDeviceTime(value: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}

function notificationLabel(
  registration: NotificationState,
  serverStatus: "not_registered" | "active" | "invalid" | undefined,
) {
  if (serverStatus === "invalid") return "Rejected by provider";
  if (registration.status === "loading") return "Checking";
  if (registration.status === "not_granted") return "Not allowed";
  if (registration.status === "unavailable") return "Unavailable";
  if (serverStatus === "active") return "Ready";
  return "Ready to register";
}

function anchorText(criterion: Criterion, score: number) {
  if (score === 0) return criterion.anchors.zero;
  if (score === 1) return criterion.anchors.one;
  if (score === 2) return criterion.anchors.two;
  if (score === 3) return criterion.anchors.three;
  if (score === 4) return criterion.anchors.four;
  return "Choose a published score from 0 to 4.";
}

function submissionProblem(criteria: Criterion[], ratings: Rating[]) {
  if (ratings.length !== criteria.length) return "Rate every assigned criterion before submitting.";
  for (const criterion of criteria) {
    const rating = ratings.find((candidate) => candidate.criterionId === criterion.id,
    );
    if (!rating) return "Rate every assigned criterion before submitting.";
    if (
      (rating.score === 0 || rating.score === 4) &&
      (!rating.evidenceNote || rating.evidenceNote.trim().length < 3)
    ) {
      return `${criterion.label}: add a short evidence note for a score of ${rating.score}.`;
    }
  }
  return null;
}

function dutyStateDetail(current: ReviewerNow) {
  if (current.reserve) {
    return current.reserve.status === "paged" ? "You have been paged" : "On call";
  }
  return "Waiting for a team";
}

function errorMessage(caught: unknown, fallback: string) {
  return describeError(caught, fallback);
}

const styles = StyleSheet.create({
  panel: { flexGrow: 1, marginTop: 8, gap: 16 },
  eyebrow: {
    maxWidth: "100%",
    color: palette.judging,
    fontSize: 13,
    fontWeight: "600",
    letterSpacing: 0.6,
    marginBottom: 6,
  },
  heading: {
    color: palette.text,
    fontSize: 30,
    fontWeight: "600",
    letterSpacing: -0.8,
    lineHeight: 35,
  },
  reviewHeading: { gap: 10 },
  reviewHeadingRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
  },
  reviewHeadingText: { flex: 1, gap: 4 },
  reviewTitle: {
    color: palette.text,
    fontSize: 30,
    fontWeight: "600",
    letterSpacing: -0.8,
    lineHeight: 36,
  },
  body: { color: palette.muted, fontSize: 15, lineHeight: 22 },
  value: { color: palette.text, fontSize: 16, lineHeight: 22 },
  idea: { color: palette.text, fontSize: 18, lineHeight: 26 },
  question: { color: palette.muted, fontSize: 14, lineHeight: 21, marginTop: 8,
  },
  guidance: { color: palette.faint, fontSize: 13, lineHeight: 19 },
  meta: { color: palette.faint, fontSize: 13, lineHeight: 18 },
  label: { color: palette.faint, fontSize: 13 },
  error: { color: palette.urgent, fontSize: 14, lineHeight: 20 },
  details: { borderTopWidth: 1, borderTopColor: palette.tile },
  detailRow: {
    minHeight: 40,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 20,
    borderBottomWidth: 1,
    borderBottomColor: palette.tile,
  },
  detailValue: { color: palette.muted, fontSize: 14, textAlign: "right" },
  disabled: { opacity: 0.5 },
  waiting: { gap: 10, paddingVertical: 8 },
  pauseNotice: {
    gap: 7,
    padding: 13,
    borderWidth: 1,
    borderColor: palette.urgent,
    borderRadius: radius.tile,
    backgroundColor: palette.tile,
  },
  pagePrompt: { gap: 14 },
  availabilityBlock: { gap: 10, paddingTop: 6 },
  rule: { height: 1, backgroundColor: palette.tile, marginVertical: 4 },
  scannerBlock: { gap: 12 },
  conflictBlock: {
    gap: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: palette.urgent,
    borderRadius: radius.tile,
  },
  textButton: { color: palette.muted, fontSize: 14, textDecorationLine: "underline",
  },
  camera: { width: "100%", height: 330, borderRadius: radius.tile, overflow: "hidden",
  },
  contextBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14,
  },
  contextText: { flex: 1, gap: 3 },
  contextTeam: { color: palette.text, fontSize: 18, fontWeight: "600", letterSpacing: -0.3,
  },
  contextDetail: { color: palette.muted, fontSize: 13 },
  clockChip: {
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: palette.tile,
    alignItems: "center",
    justifyContent: "center",
  },
  clockText: {
    color: palette.text,
    fontSize: 15,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  clockLate: { color: palette.urgent },
  evidenceLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
  },
  evidenceLinkText: { color: palette.muted, fontSize: 15 },
  evidenceLinkChevron: { color: palette.faint, fontSize: 18, lineHeight: 20 },
  evidenceSheet: { maxHeight: 640 },
  workspace: { gap: 24 },
  section: { gap: 12, paddingTop: 8 },
  sectionTitle: {
    color: palette.text,
    fontSize: 20,
    fontWeight: "600",
    letterSpacing: -0.4,
    lineHeight: 25,
  },
  evidenceHeader: {
    marginTop: 14,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
  },
  evidenceRow: { borderTopWidth: 1, borderTopColor: palette.tile, paddingTop: 10, gap: 3,
  },
  criterion: { paddingTop: 6, gap: 10 },
  stepMeter: { flexDirection: "row", gap: 6 },
  stepSegment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: palette.tile,
  },
  stepSegmentDone: { backgroundColor: palette.judging },
  stepSegmentCurrent: { backgroundColor: palette.strong },
  scorecard: { gap: 12, paddingTop: 4 },
  outcome: { alignItems: "center", gap: 10, paddingVertical: 36, paddingHorizontal: 12,
  },
  outcomeTitle: {
    marginTop: 10,
    color: palette.text,
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  outcomeBody: { color: palette.muted, fontSize: 15, lineHeight: 21, textAlign: "center",
  },
  outcomeNext: {
    marginTop: 14,
    color: palette.faint,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
  },
  drawnDisc: { alignItems: "center", justifyContent: "center" },
  failBlock: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 6,
  },
  failText: { flex: 1, gap: 3 },
  failTitle: { color: palette.text, fontSize: 16, fontWeight: "600" },
  stepDock: { gap: 10, marginTop: 10 },
  summaryRow: {
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  summaryRowRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.strong,
  },
  summaryPressed: { opacity: 0.6 },
  summaryLabel: { flex: 1, color: palette.text, fontSize: 16 },
  summaryScore: {
    color: palette.judging,
    fontSize: 20,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
  },
  summaryMissing: { color: palette.faint, fontSize: 20 },
  criterionLabel: { color: palette.text, fontSize: 19, fontWeight: "600", letterSpacing: -0.3,
  },
  criterionQuestion: { color: palette.muted, fontSize: 16, lineHeight: 22 },
  scoreRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  scoreButton: {
    width: 44,
    height: 44,
    borderWidth: 1,
    borderColor: palette.strong,
    borderRadius: radius.control,
    justifyContent: "center",
    alignItems: "center",
  },
  scoreSelected: { backgroundColor: palette.text, borderColor: palette.text },
  scoreText: { color: palette.muted, fontSize: 16 },
  scoreSelectedText: { color: palette.background, fontWeight: "700" },
  anchor: { minHeight: 40, color: palette.muted, fontSize: 15, lineHeight: 21 },
  input: {
    minHeight: 72,
    borderWidth: 1,
    borderColor: palette.tile,
    borderRadius: radius.tile,
    color: palette.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlignVertical: "top",
    fontSize: 14,
    lineHeight: 20,
  },
  privateInput: { minHeight: 96 },
  wheel: { height: 162 },
  codeInput: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: palette.tile,
    borderRadius: radius.tile,
    color: palette.text,
    paddingHorizontal: 12,
    fontFamily: "monospace",
    fontSize: 17,
    letterSpacing: 1.5,
  },
});
