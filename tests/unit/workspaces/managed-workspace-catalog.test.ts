import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";

function catalogPath(): string {
  return join(mkdtempSync(join(tmpdir(), "bridge-catalog-")), "managed-workspaces.json");
}

function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

test("loads an absent catalog as empty and round-trips registrations through the file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-catalog-"));
  const path = join(directory, "managed-workspaces.json");
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  assert.deepEqual(catalog.entries(), []);

  const first = await catalog.registerOnce("/canonical/a");
  assert.equal(first.created, true);
  const second = await catalog.registerOnce("/canonical/b");

  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), [
    { id: first.id, root: "/canonical/a" },
    { id: second.id, root: "/canonical/b" }
  ]);
  // Atomic writes leave no temporary files behind.
  assert.deepEqual(readdirSync(directory), ["managed-workspaces.json"]);
});

test("registerOnce returns the existing id for the same root without duplicating", async () => {
  const catalog = new ManagedWorkspaceCatalog(undefined);
  const first = await catalog.registerOnce("/canonical/a");
  const second = await catalog.registerOnce("/canonical/a");

  assert.equal(second.id, first.id);
  assert.equal(second.created, false);
  assert.deepEqual(catalog.entries(), [{ id: first.id, root: "/canonical/a" }]);
});

test("concurrent registerOnce calls for the same root converge on one id and one record", async () => {
  const path = catalogPath();
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();

  const [first, second] = await Promise.all([
    catalog.registerOnce("/canonical/same"),
    catalog.registerOnce("/canonical/same")
  ]);

  assert.equal(first.id, second.id);
  assert.notEqual(first.created, second.created);

  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), [{ id: first.id, root: "/canonical/same" }]);
});

test("a persist failure rolls back the in-memory record and allows a later retry", async () => {
  const path = catalogPath();
  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();

  // Block the state file path with a directory so the atomic rename fails.
  mkdirSync(path);
  await expectCode(() => catalog.registerOnce("/canonical/x"), "INTERNAL_ERROR");
  assert.deepEqual(catalog.entries(), []);

  rmSync(path, { recursive: true, force: true });
  const retried = await catalog.registerOnce("/canonical/x");
  assert.equal(retried.created, true);
  const reloaded = new ManagedWorkspaceCatalog(path);
  await reloaded.load();
  assert.deepEqual(reloaded.entries(), [{ id: retried.id, root: "/canonical/x" }]);
});

test("skips individually invalid records and rejects a corrupt whole file", async () => {
  const path = catalogPath();
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    workspaces: [
      { id: "not-a-uuid", root: "/canonical/bad-id" },
      { id: "00000000-0000-4000-8000-000000000001", root: "relative/root" },
      { id: "00000000-0000-4000-8000-000000000002", root: "/canonical/ok" },
      { id: "00000000-0000-4000-8000-000000000002", root: "/canonical/dup-id" },
      { id: "00000000-0000-4000-8000-000000000003", root: "/canonical/ok" }
    ]
  }, null, 2)}\n`);

  const catalog = new ManagedWorkspaceCatalog(path);
  await catalog.load();
  assert.deepEqual(catalog.entries(), [
    { id: "00000000-0000-4000-8000-000000000002", root: "/canonical/ok" }
  ]);

  writeFileSync(path, "not json at all");
  await expectCode(() => new ManagedWorkspaceCatalog(path).load(), "INTERNAL_ERROR");

  writeFileSync(path, `${JSON.stringify({ version: 2, workspaces: [] })}\n`);
  await expectCode(() => new ManagedWorkspaceCatalog(path).load(), "INTERNAL_ERROR");
});

test("a catalog without a state file path stays process-local", async () => {
  const catalog = new ManagedWorkspaceCatalog(undefined);
  await catalog.load();
  const { id } = await catalog.registerOnce("/canonical/local");
  assert.deepEqual(catalog.entries(), [{ id, root: "/canonical/local" }]);
});
