import { Camera } from "expo-camera";
import { useCallback } from "react";
import { Linking } from "react-native";

import { useDeviceCheck } from "./use-device-check";

export function useCameraAccess() {
  const { value, error, refresh, request } = useDeviceCheck(
    Camera.getCameraPermissionsAsync,
    "Camera access could not be checked. Open Settings and try again.",
  );
  const requestPermission = useCallback(
    () =>
      request(async () => {
        const current = await Camera.getCameraPermissionsAsync();
        if (current.granted) return current;
        if (!current.canAskAgain) {
          await Linking.openSettings();
          return Camera.getCameraPermissionsAsync();
        }
        return Camera.requestCameraPermissionsAsync();
      }),
    [request],
  );
  return { permission: value, requestPermission, error, refresh };
}
