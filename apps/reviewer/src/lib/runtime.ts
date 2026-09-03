import { ConvexReactClient } from "convex/react";

import { createReviewerAuthClient } from "./auth-client";
import { reviewerConfiguration } from "./config";

export const reviewerRuntime = reviewerConfiguration
  ? {
      configuration: reviewerConfiguration,
      convex: new ConvexReactClient(reviewerConfiguration.convexUrl, {
        unsavedChangesWarning: false,
      }),
      authClient: createReviewerAuthClient(
        reviewerConfiguration.convexSiteUrl,
        reviewerConfiguration.scheme,
      ),
    }
  : null;

export type ReviewerRuntime = NonNullable<typeof reviewerRuntime>;
