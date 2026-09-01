export const maximumReviewRoundsPerEvent = 20;
export const maximumReviewCriteriaPerRubric = 20;
export const maximumReviewerAssignmentsPerEvent = 100;
export const maximumReviewPanelsPerRound = 100;
export const maximumReviewersPerPanel = 7;
export const maximumReviewReservesPerRound = 100;
/**
 * The public application round can be much larger than the eventual offline
 * event. With teams of two through five, 3,000 applicants require room for as
 * many as 1,500 teams before admissions reduces the cohort.
 */
export const maximumApplicantTeamsPerEvent = 1_500;

/** The bounded cohort that may enter offline review and venue operations. */
export const maximumReviewTeamsPerEvent = 400;
export const maximumReviewSessionsPerTeamRound = 20;
export const maximumActiveReviewGrantsPerPermission = 2_000;
