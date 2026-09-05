"use node";
import { z } from "zod";
import { repositoryOctokit } from "./githubClient";

export const repositoryInventoryEntry = z.object({
  path: z.string(),
  sha: z.string(),
  type: z.enum(["blob", "commit"]),
  mode: z.string(),
  size: z.number().optional(),
});
export type RepositoryInventoryEntry = z.infer<typeof repositoryInventoryEntry>;
export type ReviewRepositoryAccess = {
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
  headSha: string;
  rootPath?: string;
};

/** All tracked entries at the exact commit. A truncated provider tree is traversed, never treated as complete. */
export async function repositoryInventory(access: ReviewRepositoryAccess) {
  const github = await repositoryOctokit(
    access.installationId,
    access.repositoryId,
  );
  const common = { owner: access.owner, repo: access.name };
  const commit = await github.rest.git.getCommit({
    ...common,
    commit_sha: access.headSha,
  });
  let rootSha = commit.data.tree.sha;
  for (const segment of (access.rootPath ?? "").split("/").filter(Boolean)) {
    const tree = await github.rest.git.getTree({
      ...common,
      tree_sha: rootSha,
    });
    if (tree.data.truncated)
      throw new Error("The provider did not return a complete root directory.");
    const node = tree.data.tree.find(
      (entry) => entry.path === segment && entry.type === "tree",
    );
    if (!node?.sha)
      throw new Error(
        "The connected repository root no longer exists at this commit.",
      );
    rootSha = node.sha;
  }
  const recursive = await github.rest.git.getTree({
    ...common,
    tree_sha: rootSha,
    recursive: "1",
  });
  const entries: RepositoryInventoryEntry[] = [];
  const collect = (tree: typeof recursive.data.tree, prefix: string) => {
    for (const entry of tree)
      if (entry.type === "blob" || entry.type === "commit")
        entries.push(
          repositoryInventoryEntry.parse({
            ...entry,
            path: [prefix, entry.path].filter(Boolean).join("/"),
          }),
        );
  };
  if (!recursive.data.truncated) collect(recursive.data.tree, "");
  else {
    const pending = [{ sha: rootSha, path: "" }];
    while (pending.length) {
      const directory = pending.pop();
      if (!directory) break;
      const tree = await github.rest.git.getTree({
        ...common,
        tree_sha: directory.sha,
      });
      if (tree.data.truncated)
        throw new Error(
          "The provider did not return a complete directory inventory.",
        );
      collect(tree.data.tree, directory.path);
      for (const child of tree.data.tree)
        if (child.type === "tree" && child.sha && child.path)
          pending.push({
            sha: child.sha,
            path: [directory.path, child.path].filter(Boolean).join("/"),
          });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export async function repositoryBlob(
  access: ReviewRepositoryAccess,
  entry: RepositoryInventoryEntry,
  github: Awaited<ReturnType<typeof repositoryOctokit>>,
) {
  const result = await github.rest.git.getBlob({
    owner: access.owner,
    repo: access.name,
    file_sha: entry.sha,
  });
  if (result.data.sha !== entry.sha || result.data.encoding !== "base64")
    throw new Error("Repository blob does not match the pinned inventory.");
  const bytes = Buffer.from(result.data.content, "base64");
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
