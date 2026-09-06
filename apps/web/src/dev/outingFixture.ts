import type { ServiceQueueView } from "../components/dashboard/ServiceQueuesTile";

export function outingFixture(overrides: Partial<ServiceQueueView> = {}): ServiceQueueView {
  return {
    kind: "outing_permission", status: "available", position: null, waitingCount: 0,
    capacity: 15, occupiedCount: 0, permissionExpiresAt: null, returnBy: null,
    canRequest: true, serverNow: Date.now(), ...overrides,
  };
}
