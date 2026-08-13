import { describe, expect, it } from "vitest";

import {
  HttpBodyTooLargeError,
  readBoundedJsonResponse,
  readBoundedRequestText,
} from "./boundedHttpBody";

describe("bounded JSON responses", () => {
  it("parses JSON within the byte limit", async () => {
    await expect(
      readBoundedJsonResponse(Response.json({ state: "accepted" }), 1_024),
    ).resolves.toEqual({ state: "accepted" });
  });

  it("rejects non-JSON and declared oversized bodies", async () => {
    await expect(
      readBoundedJsonResponse(new Response("ok", { headers: { "content-type": "text/plain" } }), 8),
    ).rejects.toThrow("not JSON");
    await expect(
      readBoundedJsonResponse(
        new Response("{}", {
          headers: { "content-length": "9", "content-type": "application/json" },
        }),
        8,
      ),
    ).rejects.toBeInstanceOf(HttpBodyTooLargeError);
  });

  it("stops a chunked body once its actual bytes exceed the limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new TextEncoder().encode('too large"}'));
        controller.close();
      },
    });
    await expect(
      readBoundedJsonResponse(
        new Response(body, { headers: { "content-type": "application/json" } }),
        10,
      ),
    ).rejects.toBeInstanceOf(HttpBodyTooLargeError);
  });

  it("bounds chunked request bodies before decoding them", async () => {
    await expect(
      readBoundedRequestText(
        new Request("https://example.test", { method: "POST", body: "123456789" }),
        8,
      ),
    ).rejects.toBeInstanceOf(HttpBodyTooLargeError);
  });

  it("rejects invalid limits at the owning boundary", async () => {
    await expect(
      readBoundedRequestText(new Request("https://example.test"), 0),
    ).rejects.toBeInstanceOf(RangeError);
  });
});
