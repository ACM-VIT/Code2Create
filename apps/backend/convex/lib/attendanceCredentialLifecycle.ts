import { ConvexError } from "convex/values";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export const attendanceCredentialVerificationLifetimeMs = 5 * 60 * 1_000;

export function isCurrentPendingAttendanceCredential(
  credential: Doc<"attendanceCredentials">,
  now: number,
) {
  return (
    credential.state === "pending_verification" &&
    credential.pendingExpiresAt !== undefined &&
    credential.pendingExpiresAt > now
  );
}

export async function expirePendingAttendanceCredential(
  ctx: MutationCtx,
  args: {
    credentialId: Id<"attendanceCredentials">;
    expectedVersion: number;
    now: number;
  },
) {
  const credential = await ctx.db.get(args.credentialId);
  if (
    !credential ||
    credential.state !== "pending_verification" ||
    credential.version !== args.expectedVersion ||
    (credential.pendingExpiresAt !== undefined && credential.pendingExpiresAt > args.now)
  ) {
    return false;
  }
  await ctx.db.patch(credential._id, {
    state: "revoked",
    version: credential.version + 1,
    pendingExpiresAt: undefined,
    revokedAt: args.now,
    revokeReason: "Barcode verification was not completed in time",
  });
  return true;
}

export async function completeVitBarcodeReplacement(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membershipId: Id<"eventMemberships">;
    priorCredentialId: Id<"attendanceCredentials">;
    expectedPriorCredentialVersion: number;
    replacementCredentialId: Id<"attendanceCredentials">;
    lookupHash: string;
    symbology: NonNullable<Doc<"attendanceCredentials">["barcodeSymbology"]>;
    actorPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const [prior, replacement] = await Promise.all([
    ctx.db.get(args.priorCredentialId),
    ctx.db.get(args.replacementCredentialId),
  ]);
  if (
    !prior ||
    prior.eventId !== args.eventId ||
    prior.membershipId !== args.membershipId ||
    prior.kind !== "vit_id_barcode" ||
    (prior.state !== "active" && prior.state !== "suspended") ||
    prior.version !== args.expectedPriorCredentialVersion
  ) {
    throw new ConvexError({
      code: "PRIOR_CREDENTIAL_CHANGED",
      message: "The active VIT ID binding changed. Start the rebind again.",
    });
  }
  if (
    !replacement ||
    replacement.eventId !== args.eventId ||
    replacement.membershipId !== args.membershipId ||
    replacement.kind !== "vit_id_barcode" ||
    replacement.state !== "pending_verification" ||
    replacement.supersedesCredentialId !== prior._id ||
    replacement.replacementReason !== args.reason ||
    replacement.lookupHash !== args.lookupHash ||
    replacement.barcodeSymbology !== args.symbology
  ) {
    throw new ConvexError({
      code: "VERIFICATION_MISMATCH",
      message: "The second scan did not match the pending VIT ID replacement.",
    });
  }
  if (!isCurrentPendingAttendanceCredential(replacement, args.now)) {
    throw new ConvexError({
      code: "VERIFICATION_EXPIRED",
      message: "The VIT ID replacement expired. Start again with the participant.",
    });
  }
  const matchingCredentials = await ctx.db
    .query("attendanceCredentials")
    .withIndex("by_event_lookup", (index) =>
      index.eq("eventId", args.eventId).eq("lookupHash", args.lookupHash),
    )
    .collect();
  const conflictingCredential = matchingCredentials.find(
    (credential) =>
      credential._id !== replacement._id &&
      (credential.state === "active" || isCurrentPendingAttendanceCredential(credential, args.now)),
  );
  if (conflictingCredential) {
    throw new ConvexError({
      code: "BARCODE_ALREADY_BOUND",
      message: "This VIT ID barcode is already bound to another active credential.",
    });
  }
  await ctx.db.patch(prior._id, {
    state: "replaced",
    version: prior.version + 1,
    replacedByCredentialId: replacement._id,
    revokedByPersonId: args.actorPersonId,
    revokedAt: args.now,
    revokeReason: args.reason,
  });
  await ctx.db.patch(replacement._id, {
    state: "active",
    version: replacement.version + 1,
    pendingExpiresAt: undefined,
    verifiedAt: args.now,
  });
  return {
    priorCredentialState: prior.state,
    priorCredentialVersion: prior.version + 1,
    replacementCredentialVersion: replacement.version + 1,
  };
}

export async function suspendActiveVitBarcode(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membershipId: Id<"eventMemberships">;
    credentialId: Id<"attendanceCredentials">;
    expectedCredentialVersion: number;
    actorPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const credential = await ctx.db.get(args.credentialId);
  if (
    !credential ||
    credential.eventId !== args.eventId ||
    credential.membershipId !== args.membershipId ||
    credential.kind !== "vit_id_barcode" ||
    credential.state !== "active" ||
    credential.version !== args.expectedCredentialVersion
  ) {
    throw new ConvexError({
      code: "CREDENTIAL_CHANGED",
      message: "The active VIT ID binding changed. Refresh before suspending it.",
    });
  }
  const pendingCredentials = await ctx.db
    .query("attendanceCredentials")
    .withIndex("by_membership_state", (index) =>
      index.eq("membershipId", args.membershipId).eq("state", "pending_verification"),
    )
    .collect();
  const pendingReplacements = pendingCredentials.filter(
    (candidate) =>
      candidate.kind === "vit_id_barcode" && candidate.supersedesCredentialId === credential._id,
  );
  await ctx.db.patch(credential._id, {
    state: "suspended",
    version: credential.version + 1,
    revokedByPersonId: args.actorPersonId,
    revokedAt: args.now,
    revokeReason: args.reason,
  });
  for (const pending of pendingReplacements) {
    await ctx.db.patch(pending._id, {
      state: "revoked",
      version: pending.version + 1,
      pendingExpiresAt: undefined,
      revokedByPersonId: args.actorPersonId,
      revokedAt: args.now,
      revokeReason: args.reason,
    });
  }
  return {
    credentialVersion: credential.version + 1,
    cancelledPendingCredentialIds: pendingReplacements.map((pending) => pending._id),
  };
}

async function requireUnusedBadgeIdentity(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    credentialId: Id<"attendanceCredentials">;
    lookupHash: string;
    badgeReference: string;
  },
) {
  const [lookupMatches, referenceMatches] = await Promise.all([
    ctx.db
      .query("attendanceCredentials")
      .withIndex("by_event_lookup", (index) =>
        index.eq("eventId", args.eventId).eq("lookupHash", args.lookupHash),
      )
      .collect(),
    ctx.db
      .query("attendanceCredentials")
      .withIndex("by_event_badge_reference", (index) =>
        index.eq("eventId", args.eventId).eq("badgeReference", args.badgeReference),
      )
      .collect(),
  ]);
  if (
    lookupMatches.some((credential) => credential._id !== args.credentialId) ||
    referenceMatches.some((credential) => credential._id !== args.credentialId)
  ) {
    throw new ConvexError({
      code: "BADGE_ALREADY_USED",
      message: "This event badge was already used. Choose a different printed badge.",
    });
  }
}

export async function completeExternalBadgeIssue(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membershipId: Id<"eventMemberships">;
    credentialId: Id<"attendanceCredentials">;
    lookupHash: string;
    badgeReference: string;
    now: number;
  },
) {
  const credential = await ctx.db.get(args.credentialId);
  if (
    !credential ||
    credential.eventId !== args.eventId ||
    credential.membershipId !== args.membershipId ||
    credential.kind !== "badge_qr" ||
    credential.state !== "pending_verification" ||
    credential.supersedesCredentialId !== undefined ||
    credential.lookupHash !== args.lookupHash ||
    credential.badgeReference !== args.badgeReference
  ) {
    throw new ConvexError({
      code: "VERIFICATION_MISMATCH",
      message: "The second scan did not match the pending event badge.",
    });
  }
  if (!isCurrentPendingAttendanceCredential(credential, args.now)) {
    throw new ConvexError({
      code: "VERIFICATION_EXPIRED",
      message: "The event badge setup expired. Start again with the participant.",
    });
  }
  await requireUnusedBadgeIdentity(ctx, {
    eventId: args.eventId,
    credentialId: credential._id,
    lookupHash: args.lookupHash,
    badgeReference: args.badgeReference,
  });
  const activeCredentials = await ctx.db
    .query("attendanceCredentials")
    .withIndex("by_membership_state", (index) =>
      index.eq("membershipId", args.membershipId).eq("state", "active"),
    )
    .collect();
  if (activeCredentials.some((candidate) => candidate.kind === "badge_qr")) {
    throw new ConvexError({
      code: "REPLACEMENT_REQUIRED",
      message: "This participant already has an active event badge. Use replacement instead.",
    });
  }
  await ctx.db.patch(credential._id, {
    state: "active",
    version: credential.version + 1,
    pendingExpiresAt: undefined,
    verifiedAt: args.now,
  });
  return { credentialVersion: credential.version + 1 };
}

export async function completeExternalBadgeReplacement(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membershipId: Id<"eventMemberships">;
    priorCredentialId: Id<"attendanceCredentials">;
    expectedPriorCredentialVersion: number;
    replacementCredentialId: Id<"attendanceCredentials">;
    lookupHash: string;
    badgeReference: string;
    actorPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const [prior, replacement] = await Promise.all([
    ctx.db.get(args.priorCredentialId),
    ctx.db.get(args.replacementCredentialId),
  ]);
  if (
    !prior ||
    prior.eventId !== args.eventId ||
    prior.membershipId !== args.membershipId ||
    prior.kind !== "badge_qr" ||
    prior.state !== "active" ||
    prior.version !== args.expectedPriorCredentialVersion
  ) {
    throw new ConvexError({
      code: "PRIOR_CREDENTIAL_CHANGED",
      message: "The active event badge changed. Start the replacement again.",
    });
  }
  if (
    !replacement ||
    replacement.eventId !== args.eventId ||
    replacement.membershipId !== args.membershipId ||
    replacement.kind !== "badge_qr" ||
    replacement.state !== "pending_verification" ||
    replacement.supersedesCredentialId !== prior._id ||
    replacement.replacementReason !== args.reason ||
    replacement.lookupHash !== args.lookupHash ||
    replacement.badgeReference !== args.badgeReference
  ) {
    throw new ConvexError({
      code: "VERIFICATION_MISMATCH",
      message: "The second scan did not match the pending event-badge replacement.",
    });
  }
  if (!isCurrentPendingAttendanceCredential(replacement, args.now)) {
    throw new ConvexError({
      code: "VERIFICATION_EXPIRED",
      message: "The event-badge replacement expired. Start again with the participant.",
    });
  }
  await requireUnusedBadgeIdentity(ctx, {
    eventId: args.eventId,
    credentialId: replacement._id,
    lookupHash: args.lookupHash,
    badgeReference: args.badgeReference,
  });
  await ctx.db.patch(prior._id, {
    state: "replaced",
    version: prior.version + 1,
    replacedByCredentialId: replacement._id,
    revokedByPersonId: args.actorPersonId,
    revokedAt: args.now,
    revokeReason: args.reason,
  });
  await ctx.db.patch(replacement._id, {
    state: "active",
    version: replacement.version + 1,
    pendingExpiresAt: undefined,
    verifiedAt: args.now,
  });
  return {
    priorCredentialVersion: prior.version + 1,
    replacementCredentialVersion: replacement.version + 1,
  };
}

export async function revokeActiveExternalBadge(
  ctx: MutationCtx,
  args: {
    eventId: Id<"events">;
    membershipId: Id<"eventMemberships">;
    credentialId: Id<"attendanceCredentials">;
    expectedCredentialVersion: number;
    actorPersonId: Id<"people">;
    reason: string;
    now: number;
  },
) {
  const credential = await ctx.db.get(args.credentialId);
  if (
    !credential ||
    credential.eventId !== args.eventId ||
    credential.membershipId !== args.membershipId ||
    credential.kind !== "badge_qr" ||
    credential.state !== "active" ||
    credential.version !== args.expectedCredentialVersion
  ) {
    throw new ConvexError({
      code: "CREDENTIAL_CHANGED",
      message: "The active event badge changed. Refresh before revoking it.",
    });
  }
  const pendingCredentials = await ctx.db
    .query("attendanceCredentials")
    .withIndex("by_membership_state", (index) =>
      index.eq("membershipId", args.membershipId).eq("state", "pending_verification"),
    )
    .collect();
  const pendingReplacements = pendingCredentials.filter(
    (candidate) =>
      candidate.kind === "badge_qr" && candidate.supersedesCredentialId === credential._id,
  );
  await ctx.db.patch(credential._id, {
    state: "revoked",
    version: credential.version + 1,
    revokedByPersonId: args.actorPersonId,
    revokedAt: args.now,
    revokeReason: args.reason,
  });
  for (const pending of pendingReplacements) {
    await ctx.db.patch(pending._id, {
      state: "revoked",
      version: pending.version + 1,
      pendingExpiresAt: undefined,
      revokedByPersonId: args.actorPersonId,
      revokedAt: args.now,
      revokeReason: args.reason,
    });
  }
  return {
    credentialVersion: credential.version + 1,
    cancelledPendingCredentialIds: pendingReplacements.map((pending) => pending._id),
  };
}
