import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect } from "react";
import "@/lib/push-notifications";

export function VenueNotificationRouting() {
  const router = useRouter();
  useEffect(() => {
    let active = true;
    const handle = (response: Notifications.NotificationResponse | null) => {
      if (
        !active ||
        !response ||
        response.notification.request.content.data?.kind !==
          "reviewer_venue_absence"
      )
        return;
      router.push("/venue");
      Notifications.clearLastNotificationResponse();
    };
    handle(Notifications.getLastNotificationResponse());
    const listener =
      Notifications.addNotificationResponseReceivedListener(handle);
    return () => {
      active = false;
      listener.remove();
    };
  }, [router]);
  return null;
}
