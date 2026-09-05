import { Platform, TurboModuleRegistry, Vibration } from "react-native";
import type { TurboModule } from "react-native";
import { z } from "zod";

const pagingReadinessSchema = z.object({
  fullScreenAllowed: z.boolean(),
  batteryUnrestricted: z.boolean(),
});

interface NativePagerAlarm extends TurboModule {
  stop(): void;
  getReadiness(): Promise<unknown>;
}

const nativePagerAlarm =
  Platform.OS === "android"
    ? TurboModuleRegistry.get<NativePagerAlarm>("Code2CreatePagerAlarm")
    : null;

export async function androidPagingReadiness() {
  if (!nativePagerAlarm) throw new Error("The native pager module is unavailable.");
  return pagingReadinessSchema.parse(await nativePagerAlarm.getReadiness());
}

// Sound stays native so pages ring while JavaScript is stopped.
const pattern = [0, 600, 400, 600];

const beatMs = 3_000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Starts vibration without restarting an active beat. */
export function startPagerAlarm() {
  if (timer !== null) return;
  const beat = () => Vibration.vibrate(pattern);
  beat();
  timer = setInterval(beat, beatMs);
}

export function stopPagerAlarm() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  Vibration.cancel();
  nativePagerAlarm?.stop();
}
