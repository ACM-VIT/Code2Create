import { ConvexError, v, type Infer } from "convex/values";
import { normalizedText, normalizedLongText } from "./strings";

export const reviewerPoolDetails = v.object({
  domain: v.string(),
  skills: v.string(),
  resumeUrl: v.string(),
  githubReference: v.string(),
});
export type ReviewerPoolDetails = Infer<typeof reviewerPoolDetails>;

export function normalizeReviewerPoolDetails(details: ReviewerPoolDetails) {
  const resumeUrl = details.resumeUrl.trim();
  if (resumeUrl) {
    let url: URL;
    try {
      url = new URL(resumeUrl);
    } catch {
      throw new ConvexError({
        code: "INVALID_RESUME_URL",
        message: "Resume links must be complete HTTPS URLs.",
      });
    }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new ConvexError({
        code: "INVALID_RESUME_URL",
        message: "Resume links must use HTTPS without embedded credentials.",
      });
    }
  }
  return {
    domain: normalizedText(details.domain, "Reviewer domain", 1, 100),
    skills: normalizedLongText(
      details.skills,
      "Declared reviewer skills",
      0,
      10_000,
    ),
    resumeUrl: normalizedText(resumeUrl, "Resume URL", 0, 2_000),
    githubReference: normalizedText(
      details.githubReference,
      "GitHub reference",
      0,
      2_000,
    ),
  };
}
