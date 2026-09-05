import * as Notifications from "expo-notifications";
import { useRootNavigationState, useRouter } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import { z } from "zod";

import { useReviewerSession } from "@/components/ReviewerSession";

const availabilityNotification = z.object({
  kind: z.enum([
    "reviewer_availability_confirmation",
    "reviewer_shift_reminder",
  ]),
});

export function ReviewNotificationRoute() {
  const { surfaces } = useReviewerSession();
  const router = useRouter();
  const navigation = useRootNavigationState();
  const canReview = surfaces.includes("reviews");

  useEffect(() => {
    if (
      !canReview ||
      !navigation?.key ||
      (Platform.OS !== "ios" && Platform.OS !== "android")
    ) {
      return;
    }
    const openAvailability = (response: Notifications.NotificationResponse) => {
      if (
        response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER ||
        !availabilityNotification.safeParse(
          response.notification.request.content.data,
        ).success
      ) {
        return;
      }
      // Fetch the signed-in reviewer's current requests instead of trusting a push's round state.
      router.navigate("/duty/reviews");
      Notifications.clearLastNotificationResponse();
    };
    const subscription =
      Notifications.addNotificationResponseReceivedListener(openAvailability);
    const response = Notifications.getLastNotificationResponse();
    if (response) openAvailability(response);
    return () => subscription.remove();
  }, [canReview, navigation?.key, router]);

  return null;
}
