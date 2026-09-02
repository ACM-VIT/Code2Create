export type LoadMode = "participant" | "public";

export type LoadWorkload =
  | "full-flow"
  | "idea-editing"
  | "intake-burst"
  | "submission-burst"
  | "subscriptions";

export type LoadTarget = "local" | "production-readonly" | "production-rehearsal" | "staging";

type LoadTargetInput = {
  acknowledgement?: string;
  clientCount: number;
  endpoint: URL;
  eventSlug: string;
  mode: LoadMode;
  workload: LoadWorkload;
};

const productionRealtimeOrigin = "https://realtime.c2c.sh";
const productionRehearsalOrigin = "https://realtime-load.c2c.sh";
const stagingRealtimeOrigin = "https://realtime-staging.c2c.sh";

function requiredAcknowledgement(target: LoadTarget, mutates: boolean) {
  if (target === "production-readonly") return "code2create-production-readonly";
  if (target === "production-rehearsal") return "code2create-production-rehearsal";
  if (target === "staging") {
    return mutates ? "code2create-staging-writes" : "code2create-staging";
  }
  return mutates ? "code2create-local-writes" : "code2create-local";
}

function identifyTarget(endpoint: URL): LoadTarget {
  if (
    endpoint.origin === "http://localhost:3210"
    || endpoint.origin === "http://127.0.0.1:3210"
  ) {
    return "local";
  }
  if (endpoint.origin === stagingRealtimeOrigin) return "staging";
  if (endpoint.origin === productionRealtimeOrigin) return "production-readonly";
  if (endpoint.origin === productionRehearsalOrigin) return "production-rehearsal";
  throw new Error("The realtime load target is not an approved Code2Create origin.");
}

export function validateLoadTarget(input: LoadTargetInput) {
  const target = identifyTarget(input.endpoint);
  const mutates = input.workload !== "subscriptions";

  if (target === "production-readonly") {
    if (
      input.mode !== "public"
      || input.workload !== "subscriptions"
      || input.eventSlug !== "code2create-7"
    ) {
      throw new Error(
        "The live production origin permits only public, read-only subscriptions for code2create-7.",
      );
    }
  }

  if (mutates) {
    if (input.mode !== "participant") {
      throw new Error("Mutating workloads require participant mode.");
    }
    if (!input.eventSlug.startsWith("load-")) {
      throw new Error("Mutating workloads run only against a disposable load-* event.");
    }
    if (target === "local" || target === "staging" || target === "production-rehearsal") {
      const acknowledgement = requiredAcknowledgement(target, true);
      if (input.acknowledgement !== acknowledgement) {
        throw new Error(`Set C2C_LOAD_ACKNOWLEDGE=${acknowledgement} for this mutating workload.`);
      }
    }
  }

  if (input.clientCount > 250) {
    const acknowledgement = requiredAcknowledgement(target, mutates);
    if (input.acknowledgement !== acknowledgement) {
      throw new Error(
        `Set C2C_LOAD_ACKNOWLEDGE=${acknowledgement} before opening more than 250 clients.`,
      );
    }
  }

  return { target, mutates } as const;
}
