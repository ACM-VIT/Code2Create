import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { ConvexHttpClient } from "convex/browser";
import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  UserIdentityAttributes,
} from "convex/server";
import { z } from "zod";
import { defaultParticipantEmailTemplates } from "@code2create/domain";

import { api, internal } from "../../convex/_generated/api.js";
import {
  admissionRecommendationModel,
  ideaQuestionRelease,
  ideaQuestionSystemInstruction,
} from "../../convex/lib/ideaSubmissionAi.ts";
import { defaultNoveltyPolicy } from "../../convex/lib/novelty.ts";
import { defaultParticipantPolicy } from "../../convex/lib/participantPolicy.ts";
import { validateLoadTarget } from "./target.ts";

declare module "convex/browser" {
  interface ConvexHttpClient {
    setAdminAuth(token: string, identity?: UserIdentityAttributes): void;
    mutation<Mutation extends FunctionReference<"mutation", "internal">>(
      mutation: Mutation,
      args: FunctionArgs<Mutation>,
    ): Promise<FunctionReturnType<Mutation>>;
    function(
      anyFunction: "adapter:create",
      componentPath: "betterAuth",
      args: {
        input:
          | {
              model: "user";
              data: {
                name: string;
                email: string;
                emailVerified: boolean;
                createdAt: number;
                updatedAt: number;
              };
            }
          | {
              model: "session";
              data: {
                expiresAt: number;
                token: string;
                createdAt: number;
                updatedAt: number;
                userId: string;
              };
            };
      },
    ): Promise<unknown>;
  }
}

const configurationSchema = z.object({
  C2C_LOAD_ACKNOWLEDGE: z.string(),
  C2C_LOAD_ADMIN_KEY: z.string().min(20),
  C2C_LOAD_CLIENTS: z.coerce.number().int().min(2).max(5_000).default(3_000),
  C2C_LOAD_PREP_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(8),
  C2C_LOAD_CONVEX_URL: z.url(),
  C2C_LOAD_EVENT_SLUG: z.string().regex(/^load-[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  C2C_LOAD_IDENTITY_FILE: z.string().min(1),
  C2C_LOAD_SITE_URL: z.url(),
  C2C_LOAD_TEAM_SIZE: z.coerce.number().int().min(2).max(5).default(4),
}).passthrough();

const componentDocumentSchema = z.object({ _id: z.string().min(1) });

type AuthIdentity = {
  email: string;
  name: string;
  sessionId: string;
  userId: string;
};

function loadLabel(index: number) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function actingIdentity(identity: AuthIdentity, issuer: string): UserIdentityAttributes {
  return {
    subject: identity.userId,
    issuer,
    sessionId: identity.sessionId,
    email: identity.email,
    emailVerified: true,
    name: identity.name,
  };
}

function adminClient(url: string, adminKey: string) {
  const client = new ConvexHttpClient(url, {
    logger: false,
    skipConvexDeploymentUrlCheck: true,
  });
  client.setAdminAuth(adminKey);
  return client;
}

function identityClient(
  url: string,
  adminKey: string,
  identity: AuthIdentity,
  issuer: string,
) {
  const client = new ConvexHttpClient(url, {
    logger: false,
    skipConvexDeploymentUrlCheck: true,
  });
  client.setAdminAuth(adminKey, actingIdentity(identity, issuer));
  return client;
}

async function recordSyntheticIdentity(
  admin: ConvexHttpClient,
  args: { email: string; key: string; name: string },
): Promise<AuthIdentity> {
  const now = Date.now();
  const userDocument: unknown = await admin.function(
    "adapter:create",
    "betterAuth",
    {
      input: {
        model: "user",
        data: {
          name: args.name,
          email: args.email,
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      },
    },
  );
  const userId = componentDocumentSchema.parse(userDocument)._id;
  const sessionDocument: unknown = await admin.function(
    "adapter:create",
    "betterAuth",
    {
      input: {
        model: "session",
        data: {
          expiresAt: now + 12 * 60 * 60 * 1_000,
          token: randomUUID(),
          createdAt: now,
          updatedAt: now,
          userId,
        },
      },
    },
  );
  const sessionId = componentDocumentSchema.parse(sessionDocument)._id;
  await admin.mutation(
    internal.identityClaims.recordVerifiedGoogleIdentity,
    {
      authUserId: userId,
      googleSubject: `load-google-${args.key}`,
      verifiedEmail: args.email,
      displayName: args.name,
      tokenIssuedAt: now - 1_000,
      tokenExpiresAt: now + 12 * 60 * 60 * 1_000,
      verifiedAt: now,
    },
  );
  return {
    email: args.email,
    name: args.name,
    sessionId,
    userId,
  };
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
) {
  const results: Array<R | null> = Array.from({ length: values.length }, () => null);
  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        if (value === undefined) throw new Error(`Missing load fixture input ${index}.`);
        results[index] = await worker(value, index);
      }
    },
  ));
  return results.map((result, index) => {
    if (result === null) throw new Error(`Load fixture result ${index} is missing.`);
    return result;
  });
}

function noveltyEntries() {
  const domains = [
    "campus queues",
    "road maintenance",
    "waste sorting",
    "medication adherence",
    "public transit",
    "accessible navigation",
    "food redistribution",
    "water conservation",
    "local air quality",
    "student wellbeing",
    "emergency response",
    "small retail inventory",
    "farm crop planning",
    "language learning",
    "community volunteering",
    "energy monitoring",
    "digital safety",
    "public grievance routing",
    "classroom scheduling",
    "civic issue reporting",
  ] as const;
  const mechanisms = [
    "reporting and routing",
    "demand forecasting",
    "shared scheduling",
    "offline-first coordination",
    "image-assisted triage",
    "resource matching",
    "guided self-service",
    "verified status updates",
    "location-aware discovery",
    "priority queueing",
    "peer support",
    "reminder workflows",
    "capacity visibility",
    "case follow-through",
    "anonymous feedback",
  ] as const;
  return domains.flatMap((domain, domainIndex) => mechanisms.map((mechanism, mechanismIndex) => ({
    sourceKey: `load-${String(domainIndex + 1).padStart(2, "0")}-${String(mechanismIndex + 1).padStart(2, "0")}`,
    sourceYear: 2025,
    themeLabel: `${domain} · ${mechanism}`,
    summary:
      `A prior hackathon concept combined ${domain} with ${mechanism} to make an everyday process easier to understand and act on.`,
    reflectionPrompt: "What changes for the user after the first action is completed?",
  })));
}

async function configureEvent(
  organizer: ConvexHttpClient,
  args: { clients: number; eventSlug: string },
) {
  const shell = await organizer.query(api.system.getPublicShellState, {
    eventSlug: args.eventSlug,
  });
  if (shell.event !== null) {
    throw new Error("The rehearsal deployment already contains the load event. Use a fresh database.");
  }
  const now = Date.now();
  await organizer.mutation(api.system.bootstrapEvent, {
    eventSlug: args.eventSlug,
    eventName: "Code2Create production load rehearsal",
    timezone: "Asia/Kolkata",
    externalApplicationsCloseAt: now + 12 * 60 * 60 * 1_000,
    applicationsCloseAt: now + 12 * 60 * 60 * 1_000,
    vitEmailDomains: ["vitstudent.ac.in"],
    participantPolicy: {
      ...defaultParticipantPolicy,
      label: "Load rehearsal participant policy",
      profileNotice: "Synthetic load identities are used only for this disposable rehearsal.",
      projectTextNotice: "Do not include personal information in project text.",
    },
    admissionPolicyVersion: "load-admission-v1",
    admissionParticipantCapacity: Math.max(
      args.clients,
      defaultParticipantPolicy.teamMaximumSize,
    ),
    admissionMinimumHumanReviews: 2,
    admissionModel: admissionRecommendationModel,
    intakePolicy: {
      openingText: "Hello.",
      initialPrompt: "What is your project about?",
      initialHelpText: "A rough description is enough. Tell us what it does and who it helps.",
      initialIdeaMinLength: 20,
      initialIdeaMaxLength: 4_000,
      followUpAnswerMinLength: 5,
      followUpAnswerMaxLength: 1_200,
      minimumFollowUpCount: 2,
      maximumFollowUpCount: 4,
      deterministicFollowUpCount: 2,
      questionMaxLength: 140,
      allowedPurposeKeys: ["user", "problem", "experience", "event_goal", "tradeoff", "risk"],
      fallbackQuestions: [
        {
          ordinal: 1,
          text: "What problem are you solving, and who has it?",
          purposeKey: "problem",
          answerLength: "medium",
        },
        {
          ordinal: 2,
          text: "How will your solution work in practice?",
          purposeKey: "experience",
          answerLength: "medium",
        },
      ],
      blockedTerms: [
        "unoriginal",
        "overdone",
        "bad idea",
        "reject",
        "decline",
        "score",
        "judging",
        "winner",
        "why should you win",
      ],
      commonIdeaPatterns: [],
      model: {
        mode: "assisted",
        modelId: ideaQuestionRelease.modelId,
        systemInstruction: ideaQuestionSystemInstruction,
        instructionVersion: ideaQuestionRelease.instructionVersion,
        schemaVersion: ideaQuestionRelease.schemaVersion,
        redactionVersion: ideaQuestionRelease.redactionVersion,
        questionPolicyVersion: ideaQuestionRelease.questionPolicyVersion,
        evaluationSuiteVersion: ideaQuestionRelease.evaluationSuiteVersion,
      },
    },
    communicationsPolicy: {
      venueName: "Load rehearsal venue",
      venueAddress: "Disposable production-shaped environment",
      startsAt: now + 24 * 60 * 60 * 1_000,
      endsAt: now + 72 * 60 * 60 * 1_000,
      nextSteps: [{
        stableKey: "load_complete",
        title: "End the rehearsal",
        detail: "Delete the disposable event and backend after evidence is captured.",
      }],
      discordUrl: "https://discord.gg/code2create",
      discordLabel: "Open event Discord",
      notificationProvider: "cloudflare_email",
      emailTemplates: defaultParticipantEmailTemplates(),
    },
    integrationPolicy: {
      version: "load-integrations-v1",
      requiredGitHubTopic: "code2create-load",
      maxActiveGitHubRepositoriesPerTeam: 10,
      maxActiveFigmaFilesPerTeam: 10,
      githubFreezeAt: now + 48 * 60 * 60 * 1_000,
      figmaFreezeAt: now + 48 * 60 * 60 * 1_000,
    },
  });

  const novelty = await organizer.query(api.noveltyConfiguration.current, {
    eventSlug: args.eventSlug,
  });
  const draft = await organizer.mutation(api.noveltyConfiguration.createDraft, {
    eventSlug: args.eventSlug,
    policy: defaultNoveltyPolicy,
    expectedEventVersion: novelty.eventVersion,
    reason: "Prepare the disposable production load corpus",
    clientOperationId: `load-novelty-draft-${randomUUID()}`,
  });
  const imported = await organizer.action(api.noveltyConfiguration.replaceEntries, {
    eventSlug: args.eventSlug,
    corpusVersionId: draft.corpusVersionId,
    expectedRevision: draft.revision,
    entries: noveltyEntries(),
    reason: "Embed the disposable production load corpus",
    clientOperationId: `load-novelty-import-${randomUUID()}`,
  });
  const published = await organizer.mutation(api.noveltyConfiguration.publish, {
    eventSlug: args.eventSlug,
    draftCorpusId: imported.corpusVersionId,
    expectedDraftRevision: imported.revision,
    expectedDraftChecksum: imported.checksum,
    expectedEventVersion: novelty.eventVersion,
    reason: "Publish the disposable production load corpus",
    clientOperationId: `load-novelty-publish-${randomUUID()}`,
  });
  await organizer.mutation(api.eventLifecycle.transition, {
    eventSlug: args.eventSlug,
    targetStatus: "registration_open",
    expectedEventVersion: published.eventVersion,
    reason: "Open only the disposable production load rehearsal",
    clientOperationId: `load-registration-open-${randomUUID()}`,
  });
}

async function onboardParticipant(
  admin: ConvexHttpClient,
  configuration: z.infer<typeof configurationSchema>,
  index: number,
) {
  let stage = "create the synthetic auth identity";
  try {
    const label = loadLabel(index);
    const identity = await recordSyntheticIdentity(admin, {
      email: `load-participant-${index + 1}@example.test`,
      key: `participant-${index + 1}`,
      name: `Load Participant ${label}`,
    });
    const participant = identityClient(
      configuration.C2C_LOAD_CONVEX_URL,
      configuration.C2C_LOAD_ADMIN_KEY,
      identity,
      configuration.C2C_LOAD_SITE_URL,
    );
    stage = "provision the participant";
    await participant.mutation(api.participants.provision, {
      eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
      participantClass: "external_participant",
    });
    stage = "read the participant state";
    const participantState = await participant.query(api.participants.me, {
      eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
    });
    if (!participantState?.membership) {
      throw new Error(`Synthetic participant ${index + 1} was not provisioned.`);
    }
    stage = "accept the participant policy";
    await participant.mutation(api.participants.acceptPolicy, {
      eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
      participantPolicyVersionId: participantState.participantPolicy.id,
      accepted: true,
      clientOperationId: `load-${index + 1}-policy`,
    });
    stage = "save the participant profile";
    await participant.mutation(api.participants.saveProfile, {
      eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
      participantPolicyVersionId: participantState.participantPolicy.id,
      fullName: identity.name,
      phone: `+91${9_172_345_000 + index}`,
      gender: index % 2 === 0 ? "female" : "male",
      yearOfStudy: "third",
      externalUniversity: "Load Test University",
      externalCollege: "Load Test Engineering College",
      expectedProfileVersion: 0,
      clientOperationId: `load-${index + 1}-profile`,
    });
    stage = "create the GitHub star setup intent";
    const stateDigest = randomBytes(32).toString("hex");
    const setup = await participant.mutation(
      internal.githubStarGate.createSetupIntent,
      {
        eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
        stateDigest,
        pkceVerifierCiphertext: `load-rehearsal-${randomUUID()}`,
        redirectUri: `${configuration.C2C_LOAD_SITE_URL}/onboarding/github/callback`,
      },
    );
    stage = "claim the GitHub star setup intent";
    const attemptId = `load-github-${randomUUID()}`;
    const claim = await participant.mutation(
      internal.githubStarGate.claimSetupIntent,
      {
        eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
        stateDigest,
        attemptId,
      },
    );
    if (claim.kind !== "verify" || claim.intentId !== setup.intentId) {
      throw new Error(`Synthetic participant ${index + 1} did not receive the GitHub setup claim.`);
    }
    stage = "finish the GitHub star gate";
    await participant.mutation(
      internal.githubStarGate.finishSetupIntent,
      {
        eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
        intentId: claim.intentId,
        attemptId,
        githubUserId: `load-github-user-${index + 1}`,
        githubLogin: `load-user-${index + 1}`,
        authorization: { kind: "already_starred" },
      },
    );
    return identity;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : "Unknown Convex failure";
    throw new Error(
      `Could not ${stage} for synthetic participant ${index + 1}: ${detail}`,
      { cause: error },
    );
  }
}

async function main() {
  const configuration = configurationSchema.parse(process.env);
  const endpoint = new URL(configuration.C2C_LOAD_CONVEX_URL);
  validateLoadTarget({
    acknowledgement: configuration.C2C_LOAD_ACKNOWLEDGE,
    clientCount: configuration.C2C_LOAD_CLIENTS,
    endpoint,
    eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
    mode: "participant",
    workload: "full-flow",
  });
  if (endpoint.origin !== "https://realtime-load.c2c.sh") {
    throw new Error("Rehearsal fixture preparation runs only against realtime-load.c2c.sh.");
  }
  if (new URL(configuration.C2C_LOAD_SITE_URL).origin !== "https://api-load.c2c.sh") {
    throw new Error("Rehearsal fixture preparation requires the isolated api-load.c2c.sh origin.");
  }
  const remainder = configuration.C2C_LOAD_CLIENTS % configuration.C2C_LOAD_TEAM_SIZE;
  if (remainder === 1) {
    throw new Error("The final load team would contain one member. Choose another team size.");
  }

  const admin = adminClient(
    configuration.C2C_LOAD_CONVEX_URL,
    configuration.C2C_LOAD_ADMIN_KEY,
  );
  const organizerIdentity = await recordSyntheticIdentity(admin, {
    email: "load-organizer@example.test",
    key: "organizer",
    name: "Load Organizer",
  });
  const organizer = identityClient(
    configuration.C2C_LOAD_CONVEX_URL,
    configuration.C2C_LOAD_ADMIN_KEY,
    organizerIdentity,
    configuration.C2C_LOAD_SITE_URL,
  );
  await configureEvent(organizer, {
    clients: configuration.C2C_LOAD_CLIENTS,
    eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
  });
  process.stdout.write("Configured the disposable load event and novelty corpus.\n");
  await delay(2_000);

  let onboarded = 0;
  const participantIndexes = Array.from(
    { length: configuration.C2C_LOAD_CLIENTS },
    (_, index) => index,
  );
  const identities = await mapConcurrent(
    participantIndexes,
    configuration.C2C_LOAD_PREP_CONCURRENCY,
    async (index) => {
      const identity = await onboardParticipant(admin, configuration, index);
      onboarded += 1;
      if (onboarded % 100 === 0 || onboarded === configuration.C2C_LOAD_CLIENTS) {
        process.stdout.write(`Onboarded ${onboarded}/${configuration.C2C_LOAD_CLIENTS} fixtures.\n`);
      }
      return identity;
    },
  );

  const groups = Array.from(
    { length: Math.ceil(identities.length / configuration.C2C_LOAD_TEAM_SIZE) },
    (_, groupIndex) => identities.slice(
      groupIndex * configuration.C2C_LOAD_TEAM_SIZE,
      (groupIndex + 1) * configuration.C2C_LOAD_TEAM_SIZE,
    ),
  );
  let createdTeams = 0;
  await mapConcurrent(
    groups,
    configuration.C2C_LOAD_PREP_CONCURRENCY,
    async (group, groupIndex) => {
      const leaderIdentity = group[0];
      if (!leaderIdentity) throw new Error(`Load team ${groupIndex + 1} has no leader.`);
      const leader = identityClient(
        configuration.C2C_LOAD_CONVEX_URL,
        configuration.C2C_LOAD_ADMIN_KEY,
        leaderIdentity,
        configuration.C2C_LOAD_SITE_URL,
      );
      const team = await leader.mutation(api.teams.create, {
        eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
        name: `Load Team ${loadLabel(groupIndex)}`,
        clientOperationId: `load-team-${groupIndex + 1}-create`,
      });
      await Promise.all(group.slice(1).map((memberIdentity, memberIndex) => {
        const member = identityClient(
          configuration.C2C_LOAD_CONVEX_URL,
          configuration.C2C_LOAD_ADMIN_KEY,
          memberIdentity,
          configuration.C2C_LOAD_SITE_URL,
        );
        return member.mutation(api.teams.join, {
          eventSlug: configuration.C2C_LOAD_EVENT_SLUG,
          code: team.publicCode,
          clientOperationId: `load-team-${groupIndex + 1}-join-${memberIndex + 1}`,
        });
      }));
      createdTeams += 1;
      if (createdTeams % 50 === 0 || createdTeams === groups.length) {
        process.stdout.write(`Created ${createdTeams}/${groups.length} fixture teams.\n`);
      }
      return team.teamId;
    },
  );

  const identityFile = resolve(configuration.C2C_LOAD_IDENTITY_FILE);
  await writeFile(
    identityFile,
    `${JSON.stringify(identities.map((identity) =>
      actingIdentity(identity, configuration.C2C_LOAD_SITE_URL)))}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  process.stdout.write(
    `Prepared ${identities.length} participants in ${groups.length} teams. Synthetic identities were written with owner-only permissions.\n`,
  );
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown rehearsal preparation error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
