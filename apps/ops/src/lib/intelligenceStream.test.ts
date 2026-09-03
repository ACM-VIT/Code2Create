import assert from "node:assert/strict";
import test from "node:test";
import type { OperationsIntelligenceStreamAccess } from "@code2create/domain";
import type { FlueConversationMessage } from "@flue/sdk";

import {
  createIntelligenceHistoryAwareFetch,
  createIntelligenceStreamHeaderProvider,
  loadOlderIntelligenceHistory,
  mergeIntelligenceHistoryMessages,
  type IntelligenceHistoryPageState,
} from "./intelligenceStream.ts";

test("coalesces concurrent stream access and refreshes expired tickets", async () => {
  let serverNow = 10_000;
  let clientNow = 500;
  let calls = 0;
  const provider = createIntelligenceStreamHeaderProvider(
    async () => {
      calls += 1;
      return streamAccess(`ticket-${calls}`, serverNow);
    },
    () => clientNow,
  );

  const [first, second] = await Promise.all([provider.headers(), provider.headers()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  assert.equal(first["x-c2c-stream-ticket"], "ticket-1");

  serverNow += 56_000;
  clientNow += 56_000;
  const refreshed = await provider.headers();
  assert.equal(calls, 2);
  assert.equal(refreshed["x-c2c-stream-ticket"], "ticket-2");
});

test("an invalidated in-flight ticket cannot repopulate the stream cache", async () => {
  let resolveFirstLoad: ((value: OperationsIntelligenceStreamAccess) => void) | undefined;
  const firstLoad = new Promise<OperationsIntelligenceStreamAccess>((resolve) => {
    resolveFirstLoad = resolve;
  });
  let calls = 0;
  const provider = createIntelligenceStreamHeaderProvider(
    async () => {
      calls += 1;
      return calls === 1 ? firstLoad : streamAccess("ticket-current", 20_000);
    },
    () => 1_000,
  );

  const staleHeaders = provider.headers();
  provider.invalidate();
  const currentHeaders = provider.headers();
  if (!resolveFirstLoad) throw new Error("The first stream access load did not start.");
  resolveFirstLoad(streamAccess("ticket-stale", 10_000));

  await assert.rejects(staleHeaders, /changed while access was loading/u);
  assert.equal((await currentHeaders)["x-c2c-stream-ticket"], "ticket-current");
  assert.equal(calls, 2);
});

test("rejects malformed stream access before exposing headers", async () => {
  const provider = createIntelligenceStreamHeaderProvider(async () => ({
    conversationUrl: "not a URL",
    ticket: "ticket",
    issuedAt: 1,
    expiresAt: 2,
    serverNow: 1,
    signature: "signature",
  }));

  await assert.rejects(provider.headers(), /invalid access ticket/u);
});

function streamAccess(ticket: string, serverNow: number): OperationsIntelligenceStreamAccess {
  return {
    conversationUrl:
      "https://intelligence.example/v1/operations-copilot/conversations/copilot%3Aevent%3Acv",
    ticket,
    issuedAt: serverNow,
    expiresAt: serverNow + 60_000,
    serverNow,
    signature: `signature-${ticket}`,
  };
}

test("loads an opaque older history page through the strict Flue snapshot contract", async () => {
  const originalFetch = globalThis.fetch;
  const message = lifecycleMessage("message-older");
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
    assert.equal(url.searchParams.get("view"), "history");
    assert.equal(url.searchParams.get("before"), "opaque-before");
    return Response.json(
      {
        v: 1,
        conversationId: "autonomy-run",
        offset: "4_0",
        incarnation: "incarnation-a",
        messages: [message],
        settlements: [],
      },
      {
        headers: {
          "Intelligence-History-Before": "opaque-next",
          "Intelligence-History-Has-Earlier": "true",
        },
      },
    );
  };
  try {
    const result = await loadOlderIntelligenceHistory({
      before: "opaque-before",
      conversationUrl: "https://intelligence.example/v1/operations-autonomy-runs/autonomy-run",
      headers: async () => ({ authorization: "ticket" }),
    });
    assert.deepEqual(result.snapshot.messages, [message]);
    assert.deepEqual(result.page, {
      before: "opaque-next",
      hasEarlier: true,
      incarnation: "incarnation-a",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("captures the head cursor and prepends older messages exactly once", async () => {
  const originalFetch = globalThis.fetch;
  const captured: IntelligenceHistoryPageState[] = [];
  globalThis.fetch = async () =>
    Response.json(
      {
        v: 1,
        conversationId: "autonomy-run",
        offset: "8_0",
        messages: [lifecycleMessage("message-current")],
        settlements: [],
      },
      {
        headers: {
          "Intelligence-History-Before": "opaque-before",
          "Intelligence-History-Has-Earlier": "true",
        },
      },
    );
  try {
    const historyFetch = createIntelligenceHistoryAwareFetch((page) => captured.push(page));
    await historyFetch("https://intelligence.example/run?view=history");
    assert.deepEqual(captured, [{ before: "opaque-before", hasEarlier: true }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(
    mergeIntelligenceHistoryMessages(
      [lifecycleMessage("message-older"), lifecycleMessage("message-overlap")],
      [lifecycleMessage("message-overlap"), lifecycleMessage("message-current")],
    ).map((message) => message.id),
    ["message-older", "message-overlap", "message-current"],
  );
});

function lifecycleMessage(id: string): FlueConversationMessage {
  return {
    id,
    role: "assistant",
    purpose: "assistant",
    display: "visible",
    parts: [
      {
        type: "data-autonomy-lifecycle",
        data: {
          operation: "read_operations_data",
          status: "completed",
          durationMs: 4,
        },
      },
    ],
  };
}
