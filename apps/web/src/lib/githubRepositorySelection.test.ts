import assert from "node:assert/strict";
import { test } from "node:test";
import { githubRepositoryAddBlocker, githubRepositorySelectionConnection } from "./githubRepositorySelection.ts";

const connections = [
  { id: "personal", state: "active", repositorySelection: "all", canBrowse: true },
  { id: "organization", state: "active", repositorySelection: "selected", canBrowse: true },
  { id: "revoked", state: "revoked", repositorySelection: "all", canBrowse: false },
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

test("a shared team connection does not grant personal repository browsing", () => {
  assert.equal(githubRepositorySelectionConnection([{ id: "shared", state: "active", canBrowse: false }], "shared", "repo"), undefined);
});

const openBuild = { eventStatus: "live", canManage: true, repositoryCount: 0, maximumRepositories: 10, now: 100 };
test("repository details can be previewed before build start, but adding stays gated", () => {
  assert.equal(githubRepositorySelectionConnection(connections, "personal", "repo")?.id, "personal");
  assert.match(githubRepositoryAddBlocker({ ...openBuild, eventStatus: "registration_closed" }) ?? "", /official build/);
  assert.equal(githubRepositoryAddBlocker(openBuild), null);
});

test("adding respects permissions, the repository cap and the exact freeze boundary", () => {
  assert.match(githubRepositoryAddBlocker({ ...openBuild, canManage: false }) ?? "", /management access/);
  assert.match(githubRepositoryAddBlocker({ ...openBuild, repositoryCount: 10 }) ?? "", /limit/);
  assert.equal(githubRepositoryAddBlocker({ ...openBuild, freezeAt: 101 }), null);
  assert.match(githubRepositoryAddBlocker({ ...openBuild, freezeAt: 100 }) ?? "", /frozen/);
});
