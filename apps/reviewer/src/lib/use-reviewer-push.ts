import { useCallback, useEffect } from "react";

import {
  currentReviewerPushRegistration,
  requestReviewerPushRegistration,
  subscribeToReviewerPushTokenChanges,
  type ReviewerPushRegistration,
} from "./push-notifications";
import { useDeviceCheck } from "./use-device-check";

export function useReviewerPush(apnsEnvironment: "development" | "production") {
  const read = useCallback(
    () => currentReviewerPushRegistration(apnsEnvironment),
    [apnsEnvironment],
  );
  const { value, error, refresh, request } = useDeviceCheck(
    read,
    "Push setup could not be checked.",
  );
  useEffect(
    () => subscribeToReviewerPushTokenChanges(() => void refresh()),
    [refresh],
  );
  const requestPermission = useCallback(
    (onPermissionChecked?: () => void) =>
      request(() =>
        requestReviewerPushRegistration(apnsEnvironment, onPermissionChecked),
      ),
    [apnsEnvironment, request],
  );
  const state: ReviewerPushRegistration | { status: "loading" } = error
    ? { status: "unavailable", message: error }
    : (value ?? { status: "loading" });
  return { state, requestPermission };
}
