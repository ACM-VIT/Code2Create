export type ReviewerSeniority = "board" | "sc" | "jc";
export type PanelComposition = {
  seniorSeats: number;
  juniorSeats: number;
  allowSeniorLeadFallback: boolean;
};
export type PanelCandidate = {
  id: string;
  seniority: ReviewerSeniority;
  strength: number;
  domains: readonly string[];
  criterionKeys: readonly string[];
  completedReviews: number;
  lastReviewedAt?: number;
};

export function reviewerFitsSeat(
  seniority: ReviewerSeniority,
  seat: "lead" | "sc" | "jc",
  allowSeniorLeadFallback: boolean,
) {
  return seat === "lead"
    ? seniority === "board" || (allowSeniorLeadFallback && seniority === "sc")
    : seniority === seat;
}

/** Manual Board choices can override assessed fit while retaining an explicit warning. */
export function reviewerSeatWarnings(
  profile: Pick<PanelCandidate, "seniority" | "criterionKeys">,
  seat: { seniority: "lead" | "sc" | "jc"; criterionKeys: readonly string[] },
  allowSeniorLeadFallback: boolean,
) {
  const warnings: string[] = [];
  if (!reviewerFitsSeat(profile.seniority, seat.seniority, allowSeniorLeadFallback)) {
    warnings.push(`${profile.seniority.toUpperCase()} reviewer in a ${seat.seniority === "lead" ? "panel lead" : seat.seniority.toUpperCase()} seat.`);
  }
  const missing = seat.criterionKeys.filter(key => !profile.criterionKeys.includes(key));
  if (missing.length > 0) warnings.push(`Not assessed for ${missing.map(key => key.replaceAll("_", " ")).join(", ")}. They will inherit this seat’s scoring responsibilities.`);
  return warnings;
}

export function validatePanelComposition(
  members: readonly { seniority: ReviewerSeniority; isCoordinator: boolean }[],
  policy: PanelComposition,
) {
  if (
    !Number.isInteger(policy.seniorSeats) ||
    policy.seniorSeats < 0 ||
    !Number.isInteger(policy.juniorSeats) ||
    policy.juniorSeats < 0
  )
    throw new Error("Panel seat counts must be nonnegative whole numbers.");
  const leads = members.filter((member) => member.isCoordinator);
  if (
    leads.length !== 1 ||
    !(
      leads[0]?.seniority === "board" ||
      (policy.allowSeniorLeadFallback && leads[0]?.seniority === "sc")
    )
  )
    throw new Error(
      "Every panel needs one Board lead, or an SC lead when fallback is enabled.",
    );
  const others = members.filter((member) => !member.isCoordinator);
  if (
    others.length !== policy.seniorSeats + policy.juniorSeats ||
    others.filter((member) => member.seniority === "sc").length !==
      policy.seniorSeats ||
    others.filter((member) => member.seniority === "jc").length !==
      policy.juniorSeats
  )
    throw new Error(
      `Each panel needs ${policy.seniorSeats} SC and ${policy.juniorSeats} JC members in addition to its lead.`,
    );
}

/** A reviewable draft; publication independently validates composition and criterion coverage. */
export function planReviewPanels(
  candidates: readonly PanelCandidate[],
  count: number,
  policy: PanelComposition,
) {
  if (!Number.isInteger(count) || count < 1 || count > 40)
    throw new Error("Choose between 1 and 40 panels.");
  if (
    new Set(candidates.map((candidate) => candidate.id)).size !==
    candidates.length
  )
    throw new Error("Reviewer pool contains duplicates.");
  const available = [...candidates].sort(
    (a, b) =>
      b.strength - a.strength ||
      b.criterionKeys.length - a.criterionKeys.length ||
      a.id.localeCompare(b.id),
  );
  const selected = new Set<string>();
  const panels: Array<Array<PanelCandidate & { isCoordinator: boolean }>> =
    Array.from({ length: count }, () => []);
  const choose = (
    seniority: ReviewerSeniority,
    panel: (typeof panels)[number],
  ) => {
    const covered = new Set(
      panel.flatMap((member) =>
        member.domains.map((domain) => domain.toLowerCase()),
      ),
    );
    const eligible = available.filter(
      (candidate) =>
        !selected.has(candidate.id) && candidate.seniority === seniority,
    );
    eligible.sort(
      (a, b) =>
        (seniority === "jc"
          ? a.completedReviews - b.completedReviews ||
            (a.lastReviewedAt ?? 0) - (b.lastReviewedAt ?? 0)
          : 0) ||
        b.domains.filter((domain) => !covered.has(domain.toLowerCase()))
          .length -
          a.domains.filter((domain) => !covered.has(domain.toLowerCase()))
            .length ||
        b.strength - a.strength ||
        b.criterionKeys.length - a.criterionKeys.length ||
        a.id.localeCompare(b.id),
    );
    const candidate = eligible[0];
    if (candidate) selected.add(candidate.id);
    return candidate;
  };
  for (const panel of panels) {
    // Leadership strength takes priority over domain variety.
    const lead =
      available.find(
        (candidate) =>
          !selected.has(candidate.id) && candidate.seniority === "board",
      ) ??
      (policy.allowSeniorLeadFallback
        ? available.find(
            (candidate) =>
              !selected.has(candidate.id) && candidate.seniority === "sc",
          )
        : undefined);
    if (!lead)
      throw new Error(
        "There are not enough eligible panel leads. Adjust the panel count or lead policy.",
      );
    selected.add(lead.id);
    panel.push({ ...lead, isCoordinator: true });
  }
  for (const [seniority, seats] of [
    ["sc", policy.seniorSeats],
    ["jc", policy.juniorSeats],
  ] as const) {
    for (let seat = 0; seat < seats; seat++) {
      // Fill the currently weakest panel first to spread experience across the room.
      const ordered = [...panels].sort(
        (a, b) =>
          a.reduce((sum, member) => sum + member.strength, 0) -
          b.reduce((sum, member) => sum + member.strength, 0),
      );
      for (const panel of ordered) {
        const candidate = choose(seniority, panel);
        if (!candidate)
          throw new Error(
            `There are not enough eligible ${seniority.toUpperCase()} reviewers for ${count} panels.`,
          );
        panel.push({ ...candidate, isCoordinator: false });
      }
    }
  }
  for (const panel of panels) validatePanelComposition(panel, policy);
  return {
    panels,
    reserveIds: available
      .filter((candidate) => !selected.has(candidate.id))
      .map((candidate) => candidate.id),
  };
}
