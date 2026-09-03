import { describe, expect, test, vi } from "vitest";

import { createLatestDraftWriter } from "./latest-draft-writer";

describe("latest draft writer", () => {
  test("flushes the final edit when the screen leaves before the debounce", async () => {
    const save = vi.fn(async (_draft: { privateNote: string }) => undefined);
    const writer = createLatestDraftWriter(save);

    writer.update({ privateNote: "first edit" });
    writer.update({ privateNote: "final edit before backgrounding" });
    await writer.flush();

    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith({ privateNote: "final edit before backgrounding" });
  });

  test("does not recreate a cleared draft after authoritative save", async () => {
    const save = vi.fn(async (_draft: { privateNote: string }) => undefined);
    const writer = createLatestDraftWriter(save);
    writer.update({ privateNote: "saved by server" });
    writer.update(null);

    await writer.flush();

    expect(save).not.toHaveBeenCalled();
  });
});
