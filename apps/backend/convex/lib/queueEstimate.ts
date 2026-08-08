export type QueueEstimate = {
  lowerMinutes: number;
  upperMinutes: number;
  sampleSize: number;
  basis: "configured" | "observed";
};

export type QueueEstimateInput = {
  now: number;
  configuredDurationSeconds: number;
  teamsAhead: number;
  activeReviewPlannedEndAt?: number;
  completedDurationsSeconds: readonly number[];
};

const fiveMinutesInSeconds = 5 * 60;

export function estimateQueueWindow(input: QueueEstimateInput): QueueEstimate {
  const configuredDuration = validDuration(input.configuredDurationSeconds)
    ? input.configuredDurationSeconds
    : 10 * 60;
  const samples = input.completedDurationsSeconds
    .filter(validDuration)
    .slice(0, 9)
    .sort((left, right) => left - right);
  const observedDuration = samples.length >= 3 ? median(samples) : configuredDuration;
  const boundedPace = Math.min(
    configuredDuration * 1.5,
    Math.max(configuredDuration * 0.65, observedDuration),
  );
  const activeReviewSeconds =
    input.activeReviewPlannedEndAt === undefined
      ? 0
      : Math.max(
          Math.round(boundedPace * 0.35),
          (input.activeReviewPlannedEndAt - input.now) / 1_000,
        );
  const centralSeconds =
    Math.max(0, activeReviewSeconds) + Math.max(0, input.teamsAhead) * boundedPace;
  const lowerSeconds = centralSeconds * 0.75;
  const upperSeconds = Math.max(fiveMinutesInSeconds, centralSeconds * 1.3 + 90);

  return {
    lowerMinutes: roundDownToFiveMinutes(lowerSeconds),
    upperMinutes: roundUpToFiveMinutes(upperSeconds),
    sampleSize: samples.length,
    basis: samples.length >= 3 ? "observed" : "configured",
  };
}

function validDuration(value: number) {
  return Number.isFinite(value) && value >= 60 && value <= 60 * 60;
}

function median(sortedValues: readonly number[]) {
  const middle = Math.floor(sortedValues.length / 2);
  const upper = sortedValues[middle];
  if (upper === undefined) throw new Error("A median needs at least one value.");
  if (sortedValues.length % 2 === 1) return upper;
  const lower = sortedValues[middle - 1];
  if (lower === undefined) throw new Error("A median pair is incomplete.");
  return (lower + upper) / 2;
}

function roundDownToFiveMinutes(seconds: number) {
  return Math.max(0, Math.floor(seconds / fiveMinutesInSeconds) * 5);
}

function roundUpToFiveMinutes(seconds: number) {
  return Math.max(5, Math.ceil(seconds / fiveMinutesInSeconds) * 5);
}
