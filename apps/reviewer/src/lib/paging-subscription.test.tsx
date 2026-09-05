import { ConvexProvider, ConvexReactClient } from "convex/react";
import { ConvexError } from "convex/values";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { PagingSetup } from "../components/PagingSetup";

vi.mock("@code2create/backend/api", () => ({
  api: { outboundCallConsents: { mine: "mine", saveReviewerConsent: "save" } },
}));
vi.mock("expo-crypto", () => ({ randomUUID: () => "test-id" }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return { useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]) };
});
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: vi.fn() }) },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
  View: "View", Text: "Text", TextInput: "TextInput",
}));
vi.mock("@/components/ui", () => ({ Action: "Action", CheckRow: "CheckRow", QuietAction: "QuietAction" }));
vi.mock("@/lib/paging-settings", () => ({ openPagingSetting: vi.fn() }));
vi.mock("@/lib/push-notifications", () => ({ pagingReadiness: async () => [
  { key: "permission", title: "Notifications", met: true },
] }));

let renderer: ReturnType<typeof create>;
let client: ConvexReactClient;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  client = new ConvexReactClient("https://test.invalid");
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  await client.close();
  vi.restoreAllMocks();
});

test.each([false, true])("real Convex subscription settles without a render loop (denied=%s)", async (denied) => {
  // Keep Convex's real subscription hook. Only replace its network boundary:
  // a plain mocked useQueries hid the changing-request-identity crash.
  vi.spyOn(client, "watchQuery").mockReturnValue({
    onUpdate: () => vi.fn(),
    localQueryResult: () => {
      if (denied) throw new ConvexError({ code: "PERMISSION_DENIED", message: "Review calls unavailable" });
      return undefined;
    },
    journal: () => undefined,
  });
  const render = (eventSlug: string) => (
    <ConvexProvider client={client}>
      <PagingSetup eventSlug={eventSlug} requestPermission={async () => {}} />
    </ConvexProvider>
  );
  await act(async () => { renderer = create(render("event")); });
  expect(renderer.root.findByProps({ title: "Notifications" }).props.met).toBe(true);
  await act(async () => { renderer.update(render("another-event")); });
  expect(renderer.root.findByProps({ title: "Notifications" }).props.met).toBe(true);
  if (denied) expect(JSON.stringify(renderer.toJSON())).toContain("Review calls unavailable");
});
