import type {
  ApplicationState,
  FloorArea,
  FloorMappingState,
  ReviewRoundStatus,
  ReviewSessionStatus,
  ScorecardStatus,
  SessionPresenceState,
  SupportCaseState,
  TeamRoundState,
  TeamStatus,
  VenuePresenceState,
} from "@code2create/domain";
import type { Infer } from "convex/values";

import type {
  applicationState,
  floorArea,
  floorMappingState,
  reviewRoundStatus,
  reviewSessionStatus,
  scorecardStatus,
  sessionPresenceState,
  supportCaseState,
  teamRoundState,
  teamStatus,
  venuePresenceState,
} from "../values";

/**
 * Ties each stored state union to the user-facing wording in
 * `@code2create/domain`. Adding a state to `values.ts` without adding its
 * label makes one of the checks below stop being `true`, which fails the
 * type check rather than shipping a screen that title-cases the raw key.
 */
type SameUnion<Stored, Labelled> = [Stored] extends [Labelled]
  ? [Labelled] extends [Stored]
    ? true
    : { missingFromStored: Exclude<Labelled, Stored> }
  : { missingFromLabels: Exclude<Stored, Labelled> };

export const labelledStateUnions: true[] = [
  true as SameUnion<Infer<typeof teamRoundState>, TeamRoundState>,
  true as SameUnion<Infer<typeof reviewSessionStatus>, ReviewSessionStatus>,
  true as SameUnion<Infer<typeof reviewRoundStatus>, ReviewRoundStatus>,
  true as SameUnion<Infer<typeof scorecardStatus>, ScorecardStatus>,
  true as SameUnion<Infer<typeof teamStatus>, TeamStatus>,
  true as SameUnion<Infer<typeof applicationState>, ApplicationState>,
  true as SameUnion<Infer<typeof supportCaseState>, SupportCaseState>,
  true as SameUnion<Infer<typeof sessionPresenceState>, SessionPresenceState>,
  true as SameUnion<Infer<typeof venuePresenceState>, VenuePresenceState>,
  true as SameUnion<Infer<typeof floorArea>, FloorArea>,
  true as SameUnion<Infer<typeof floorMappingState>, FloorMappingState>,
];
