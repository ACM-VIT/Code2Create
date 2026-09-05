import assert from "node:assert/strict";
import { test } from "node:test";
import { githubRepositorySelectionConnection } from "./githubRepositorySelection.ts";

const connections = [
  { id: "personal", state: "active", repositorySelection: "all" },
  { id: "organization", state: "active", repositorySelection: "selected" },
  { id: "revoked", state: "revoked", repositorySelection: "all" },
];

test("callbacks open the exact account picker for all or selected repositories without preselecting a repository", () => {
  for (const id of ["personal", "organization"]) {
    assert.equal(githubRepositorySelectionConnection(connections, id, null)?.id, id);
  }
});

test("a missing or revoked callback connection cannot fall through to another account", () => {
  for (const id of ["missing", "revoked"]) {
    assert.equal(githubRepositorySelectionConnection(connections, id, "private-repo"), undefined);
  }
});

test("normal page visits do not open a picker, but repository links use an active connection", () => {
  assert.equal(githubRepositorySelectionConnection(connections, null, null), undefined);
  assert.equal(githubRepositorySelectionConnection(connections, null, "repo")?.id, "personal");
  assert.equal(githubRepositorySelectionConnection(connections.slice(0, 0), "personal", null), undefined);
});
