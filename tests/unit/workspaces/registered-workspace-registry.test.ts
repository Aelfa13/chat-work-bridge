import assert from "node:assert/strict";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const ROOT = "/registered/root";

function expectCode(action: () => unknown, code: string): void {
  assert.throws(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

test("returns the fixed root for a registered id", () => {
  const registry = new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT }]);

  assert.equal(registry.resolve("known"), ROOT);
});

test("rejects an unknown id", () => {
  const registry = new RegisteredWorkspaceRegistry([{ id: "known", root: ROOT }]);

  expectCode(() => registry.resolve("unknown"), "UNKNOWN_WORKSPACE");
});

test("rejects duplicate ids", () => {
  expectCode(() => new RegisteredWorkspaceRegistry([
    { id: "known", root: ROOT },
    { id: "known", root: "/other/root" }
  ]), "WORKSPACE_BOUNDARY_VIOLATION");
});

test("rejects relative, non-normalized, or empty configuration fields", () => {
  const invalidEntries = [
    [{ id: "known", root: "relative/root" }],
    [{ id: "known", root: "/registered/../root" }],
    [{ id: "", root: ROOT }],
    [{ id: "known", root: "" }]
  ];

  for (const entries of invalidEntries) {
    expectCode(() => new RegisteredWorkspaceRegistry(entries), "WORKSPACE_BOUNDARY_VIOLATION");
  }
});
