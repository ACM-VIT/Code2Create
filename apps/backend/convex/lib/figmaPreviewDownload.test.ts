import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadFigmaPreview, validFigmaPreviewUrl } from "./figmaPreviewDownload";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Figma preview downloads", () => {
  it("accepts only the exact Figma render host", () => {
    expect(
      validFigmaPreviewUrl("https://s3-alpha-sig.figma.com/img/example?sig=value"),
    ).not.toBeNull();
    expect(validFigmaPreviewUrl("https://api.figma.com/v1/images/example")).toBeNull();
    expect(validFigmaPreviewUrl("https://s3-alpha-sig.figma.com.evil.test/img/example")).toBeNull();
    expect(validFigmaPreviewUrl("https://127.0.0.1/img/example")).toBeNull();
    expect(validFigmaPreviewUrl("https://s3-alpha-sig.figma.com:8443/img/example")).toBeNull();
  });

  it("disables redirects and applies a request deadline", async () => {
    const response = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png" },
    });
    Object.defineProperty(response, "url", {
      value: "https://s3-alpha-sig.figma.com/img/example",
    });
    const request = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", request);

    await expect(
      downloadFigmaPreview("https://s3-alpha-sig.figma.com/img/example", 16),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(request).toHaveBeenCalledOnce();
    const options = request.mock.calls[0]?.[1];
    expect(options?.redirect).toBe("error");
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects oversized and unexpected responses", async () => {
    const oversizedResponse = new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "content-length": "3",
        "content-type": "image/png",
      },
    });
    Object.defineProperty(oversizedResponse, "url", {
      value: "https://s3-alpha-sig.figma.com/img/example",
    });
    const unexpectedResponse = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/jpeg" },
    });
    Object.defineProperty(unexpectedResponse, "url", {
      value: "https://s3-alpha-sig.figma.com/img/example",
    });
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oversizedResponse)
      .mockResolvedValueOnce(unexpectedResponse);
    vi.stubGlobal("fetch", request);

    await expect(
      downloadFigmaPreview("https://s3-alpha-sig.figma.com/img/example", 2),
    ).rejects.toMatchObject({ code: "preview_too_large" });
    await expect(
      downloadFigmaPreview("https://s3-alpha-sig.figma.com/img/example", 4),
    ).rejects.toMatchObject({
      code: "preview_content_type_invalid",
    });
  });
});
