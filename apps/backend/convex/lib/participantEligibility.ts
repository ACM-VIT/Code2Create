import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { ParticipantClass } from "../values";
import { normalizeEmail } from "./strings";
import {
  isApprovedVitStudentIdentity,
  parseVitRegistrationNumber,
  parseVitStudentGoogleDisplayName,
  vitIdentityReferenceYear,
} from "./vitStudentIdentity";

type ReadCtx = QueryCtx | MutationCtx;

export type ParticipantEligibilityLookup = {
  participantClass: ParticipantClass;
  identityNormalized: string;
};

export function participantEligibilityLookupFromGoogleIdentity(
  event: Doc<"events">,
  identity: {
    verifiedEmail: string;
    hostedDomain?: string;
    displayName: string;
  },
): ParticipantEligibilityLookup | null {
  const isVitStudent = isApprovedVitStudentIdentity({
    verifiedEmail: identity.verifiedEmail,
    ...(identity.hostedDomain !== undefined
      ? { hostedDomain: identity.hostedDomain }
      : {}),
    allowedDomains: event.vitEmailDomains,
  });
  if (!isVitStudent) {
    return {
      participantClass: "external_participant",
      identityNormalized: normalizeEmail(identity.verifiedEmail),
    };
  }
  const vitIdentity = parseVitStudentGoogleDisplayName(
    identity.displayName,
    vitIdentityReferenceYear(event),
  );
  if (!vitIdentity) return null;
  return {
    participantClass: "vit_student",
    identityNormalized: vitIdentity.registrationNumber,
  };
}

export function participantEligibilityLookupFromMembership(
  membership: Doc<"eventMemberships">,
  person: Doc<"people">,
): ParticipantEligibilityLookup | null {
  if (membership.participantClass === "external_participant") {
    return {
      participantClass: membership.participantClass,
      identityNormalized: normalizeEmail(person.verifiedEmail),
    };
  }
  if (!membership.vitStudentIdentity) return null;
  return {
    participantClass: membership.participantClass,
    identityNormalized: membership.vitStudentIdentity.registrationNumber,
  };
}

export async function productionParticipantEligibilityAllowed(
  ctx: ReadCtx,
  event: Doc<"events">,
  lookup: ParticipantEligibilityLookup | null,
) {
  if (!lookup || !event.publishedParticipantEligibilityImportId) return false;
  const eligibilityImport = await ctx.db.get(
    event.publishedParticipantEligibilityImportId,
  );
  if (
    !eligibilityImport ||
    eligibilityImport.eventId !== event._id ||
    eligibilityImport.status !== "active"
  ) {
    return false;
  }
  const entry = await ctx.db
    .query("participantEligibilityEntries")
    .withIndex("by_import_identity", (index) =>
      index
        .eq("participantEligibilityImportId", eligibilityImport._id)
        .eq("participantClass", lookup.participantClass)
        .eq("identityNormalized", lookup.identityNormalized),
    )
    .unique();
  return entry !== null;
}

export function normalizeEligibilityIdentity(
  participantClass: ParticipantClass,
  identity: string,
  event: Pick<Doc<"events">, "applicationsCloseAt" | "startsAt" | "timezone">,
) {
  if (participantClass === "external_participant") {
    const email = normalizeEmail(identity);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("External eligibility identities must be email addresses.");
    }
    return email;
  }
  const parsed = parseVitRegistrationNumber(
    identity,
    vitIdentityReferenceYear(event),
  );
  if (!parsed) {
    throw new Error("VIT eligibility identities must be valid registration numbers.");
  }
  return parsed.registrationNumber;
}
