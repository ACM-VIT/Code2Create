export const maximumReviewRoundsPerEvent = 20;
export const maximumReviewCriteriaPerRubric = 20;
export const maximumReviewerAssignmentsPerEvent = 100;
export const maximumReviewPanelsPerRound = 100;
export const maximumReviewersPerPanel = 7;
export const maximumReviewReservesPerRound = 100;
/** Up to 2,000 applicants in teams of at least two. */
export const maximumApplicantTeamsPerEvent = 1_000;

/** The bounded cohort that may enter offline review and venue operations. */
export const maximumReviewTeamsPerEvent = 400;
export const maximumReviewSessionsPerTeamRound = 20;
export const maximumActiveReviewGrantsPerPermission = 2_000;

/** Planning allowance after each discussion; operators can adjust it per round. */
export const defaultReviewScoringBufferSeconds = 120;
