import { beforeEach, describe, expect, test, vi } from "vitest";

const provider = vi.hoisted(() => ({
  getCommit: vi.fn(),
  getTree: vi.fn(),
  getBlob: vi.fn(),
}));
vi.mock("./githubClient", () => ({
  repositoryOctokit: async () => ({ rest: { git: provider } }),
}));
import {
  repositoryInventory,
  repositoryBlob,
} from "./reviewRepositoryInventory";
import { repositoryOctokit } from "./githubClient";

const access = {
  installationId: "1",
  repositoryId: "2",
  owner: "team",
  name: "project",
  headSha: "a".repeat(40),
};
beforeEach(() => {
  vi.resetAllMocks();
  provider.getCommit.mockResolvedValue({ data: { tree: { sha: "root" } } });
});
describe("complete pinned repository inventory", () => {
  test("retains every tracked file at arbitrary depth including lockfiles", async () => {
    provider.getTree.mockResolvedValue({
      data: {
        truncated: false,
        tree: Array.from({ length: 350 }, (_, i) => ({
          path: `a/b/c/d/e/f/${i}.ts`,
          type: "blob",
          mode: "100644",
          sha: `blob-${i}`,
          size: 40,
        })),
      },
    });
    expect(await repositoryInventory(access)).toHaveLength(350);
    expect(provider.getCommit).toHaveBeenCalledWith({
      owner: "team",
      repo: "project",
      commit_sha: access.headSha,
    });
    expect(provider.getTree).toHaveBeenCalledWith({
      owner: "team",
      repo: "project",
      tree_sha: "root",
      recursive: "1",
    });
  });
  test("walks a truncated recursive response without using its incomplete listing", async () => {
    provider.getTree
      .mockResolvedValueOnce({
        data: {
          truncated: true,
          tree: [
            {
              path: "wrong.ts",
              sha: "incomplete",
              mode: "100644",
              type: "blob",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          truncated: false,
          tree: [
            { path: "src", sha: "src", type: "tree" },
            {
              path: "pnpm-lock.yaml",
              sha: "lock",
              mode: "100644",
              type: "blob",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          truncated: false,
          tree: [
            { path: "main.ts", sha: "main", mode: "100644", type: "blob" },
          ],
        },
      });
    expect((await repositoryInventory(access)).map((e) => e.path)).toEqual([
      "pnpm-lock.yaml",
      "src/main.ts",
    ]);
  });
  test("does not claim complete coverage when the provider omits a directory", async () => {
    provider.getTree.mockResolvedValue({ data: { truncated: true, tree: [] } });
    await expect(repositoryInventory(access)).rejects.toThrow(
      "complete directory inventory",
    );
  });
  test("reads an exact blob larger than the old 256 KB cutoff without truncating it", async () => {
    const text = "export const component = 'working';\n".repeat(12000);
    provider.getBlob.mockResolvedValue({
      data: {
        sha: "blob",
        encoding: "base64",
        content: Buffer.from(text).toString("base64"),
      },
    });
    const github = await repositoryOctokit("1", "2");
    expect(
      await repositoryBlob(
        access,
        { path: "big.ts", sha: "blob", type: "blob", mode: "100644" },
        github,
      ),
    ).toBe(text);
  });
});
