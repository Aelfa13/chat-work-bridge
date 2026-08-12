import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import type { Executor, ExecutorResult } from "../../../src/executors/executor.js";
import { ControlledPatchService } from "../../../src/tasks/controlled-patch-service.js";
import type { GitStarter } from "../../../src/tasks/controlled-patch-service.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-patch-")));
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  writeFileSync(join(root, "note.txt"), "before\n");
  git(root, "add", "note.txt");
  git(root, "commit", "-qm", "base");
  return root;
}

function fixture(root: string, execute: Executor["execute"], startProcess?: GitStarter): {
  controlled: ControlledPatchService;
  tasks: RegisteredWorkspaceTaskService;
} {
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute }));
  return {
    controlled: startProcess === undefined
      ? new ControlledPatchService(registry, tasks)
      : new ControlledPatchService(registry, tasks, startProcess),
    tasks
  };
}

async function terminal(tasks: RegisteredWorkspaceTaskService, taskId: string): Promise<void> {
  while (["queued", "running"].includes(tasks.status(taskId)?.state ?? "")) {
    await new Promise<void>((done) => setImmediate(done));
  }
}

async function expectCode(action: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof CoreError && error.code === code);
}

const validPatch = `diff --git a/note.txt b/note.txt
index 90be1f3..3b18e51 100644
--- a/note.txt
+++ b/note.txt
@@ -1 +1 @@
-before
+after
`;

const additionPatch = `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..3e75765
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+added
`;

const markdownFencePatch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1,7 +1,7 @@",
  " # Example",
  " ",
  " ```sh",
  " echo ok",
  " ```",
  " ",
  "-before",
  "+after",
  ""
].join("\n");

const staleHunkCountPatch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -4,7 +4,7 @@ echo ok",
  " ```",
  " ",
  "-before",
  "+after",
  ""
].join("\n");

const zeroContextPatch = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -7 +7 @@",
  "-before",
  "+after",
  ""
].join("\n");

test("generation records base metadata, binds the task, and keeps Codex instruction read-only", async () => {
  const root = repository();
  let instruction = "";
  const gitCalls: Array<{ executable: string; args: readonly string[]; shell: unknown }> = [];
  const starter: GitStarter = (executable, args, options) => {
    gitCalls.push({ executable, args, shell: options.shell });
    return spawn(executable, args, options);
  };
  const { controlled, tasks } = fixture(root, async (request) => {
    instruction = request.instruction;
    return { kind: "completed", output: validPatch };
  }, starter);
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
  await Promise.resolve();
  assert.match(instruction, /Return only a unified textual Git diff/);
  await terminal(tasks, generated.taskId);
  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.ok(gitCalls.every((call) => call.executable === "git" && call.shell === false));
  assert.deepEqual(gitCalls.slice(-2).map((call) => call.args), [
    ["apply", "--check", "--recount", "--unidiff-zero"],
    ["apply", "--recount", "--unidiff-zero"]
  ]);
  await expectCode(
    () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
    "INVALID_STATE_TRANSITION"
  );
});

test("accepts a normal absolute Git top-level path", async () => {
  const root = repository();
  const { controlled } = fixture(root, async () => ({ kind: "completed", output: validPatch }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });

  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
});

test("accepts a symlink alias that resolves to the same Git top-level", async () => {
  const root = repository();
  const aliasParent = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-alias-")));
  const alias = join(aliasParent, "workspace-alias");
  symlinkSync(root, alias, "dir");
  const { controlled } = fixture(alias, async () => ({ kind: "completed", output: validPatch }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });

  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
});

test("rejects a different directory, a Git subdirectory, and a missing workspace", async () => {
  const root = repository();
  const other = repository();
  const nested = join(root, "nested");
  mkdirSync(nested);

  for (const invalidRoot of [other, nested, join(root, "missing")]) {
    const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root: invalidRoot, allow_write: true }]);
    const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
      execute: async () => ({ kind: "completed", output: validPatch })
    }));
    const controlled = new ControlledPatchService(registry, tasks, (executable, args, options) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel" && invalidRoot === other) {
        return spawn(executable, args, { ...options, cwd: root });
      }
      return spawn(executable, args, options);
    });
    await expectCode(
      () => controlled.generate({ workspace_id: "workspace", change_request: "change note" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});

test("stores and applies a controlled patch normalized to one trailing LF", async () => {
  const root = repository();
  const patchWithoutFinalLf = validPatch.slice(0, -1);
  const { controlled, tasks } = fixture(root, async () => ({
    kind: "completed",
    output: patchWithoutFinalLf
  }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  await terminal(tasks, generated.taskId);

  assert.deepEqual(tasks.result(generated.taskId), {
    id: generated.taskId,
    state: "completed",
    output: validPatch
  });
  await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
});

test("applies a valid patch when Markdown context contains fenced code", async () => {
  const root = repository();
  writeFileSync(join(root, "README.md"), "# Example\n\n```sh\necho ok\n```\n\nbefore\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "add Markdown fixture");
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: markdownFencePatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change Markdown" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["README.md"]);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Example\n\n```sh\necho ok\n```\n\nafter\n");
});

test("recounts stale hunk line counts in a valid generated patch", async () => {
  const root = repository();
  writeFileSync(join(root, "README.md"), "# Example\n\n```sh\necho ok\n```\n\nbefore\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "add generated patch fixture");
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: staleHunkCountPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change generated patch" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["README.md"]);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Example\n\n```sh\necho ok\n```\n\nafter\n");
});

test("applies a valid generated patch with zero context", async () => {
  const root = repository();
  writeFileSync(join(root, "README.md"), "# Example\n\n```sh\necho ok\n```\n\nbefore\ntail\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "add zero-context fixture");
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: zeroContextPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change one line" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["README.md"]);
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "# Example\n\n```sh\necho ok\n```\n\nafter\ntail\n");
});

test("adds an absent 100644 text file", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: additionPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["added.txt"]);
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
});

test("applies a mixed modification and 100644 text addition", async () => {
  const root = repository();
  const mixedPatch = `${validPatch}${additionPatch}`;
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: mixedPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change and add" });
  await terminal(tasks, generated.taskId);

  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.deepEqual(applied.changed_paths, ["note.txt", "added.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
});

test("rejects addition targets already present in base HEAD, the worktree, or the index", async () => {
  for (const state of ["tracked", "untracked", "index"] as const) {
    const root = repository();
    const path = state === "tracked" ? "note.txt" : "added.txt";
    const patch = additionPatch.replaceAll("added.txt", path);
    if (state === "untracked") writeFileSync(join(root, path), "collision\n");
    const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: patch }));
    const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
    await terminal(tasks, generated.taskId);
    if (state === "index") {
      writeFileSync(join(root, path), "indexed\n");
      git(root, "add", path);
    }
    await expectCode(
      () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});

test("rejects unsafe or structurally invalid additions", async () => {
  const invalidPatches = [
    additionPatch.replace("new file mode 100644", "new file mode 100755"),
    additionPatch.replace("new file mode 100644", "new file mode 120000"),
    additionPatch.replace("new file mode 100644", "new file mode 160000"),
    additionPatch.replace("index 0000000..3e75765", "GIT binary patch\nliteral 0\nHcmV?d00001"),
    additionPatch.replace("new file mode 100644", "deleted file mode 100644").replace("--- /dev/null", "--- a/added.txt").replace("+++ b/added.txt", "+++ /dev/null"),
    additionPatch.replace("new file mode 100644", "similarity index 100%\nrename from old.txt\nrename to added.txt"),
    additionPatch.replace("new file mode 100644", "similarity index 100%\ncopy from old.txt\ncopy to added.txt"),
    `${additionPatch}${additionPatch}`,
    additionPatch.replace("diff --git a/added.txt b/added.txt", "diff --git added.txt added.txt"),
    additionPatch.replace("+++ b/added.txt", "+++ b/other.txt"),
    additionPatch.replaceAll("added.txt", "../added.txt")
  ];

  for (const output of invalidPatches) {
    const root = repository();
    const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output }));
    const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
    await terminal(tasks, generated.taskId);
    await expectCode(
      () => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }),
      "WORKSPACE_PRECONDITION_FAILED"
    );
  }
});

test("collapses extra trailing LFs in controlled patch results", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({
    kind: "completed",
    output: `${validPatch}\n\n`
  }));

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  await terminal(tasks, generated.taskId);

  assert.deepEqual(tasks.result(generated.taskId), {
    id: generated.taskId,
    state: "completed",
    output: validPatch
  });
});

test("requires exact confirmation and a successfully completed generation task", async () => {
  const root = repository();
  let finish!: (result: ExecutorResult) => void;
  const pending = new Promise<ExecutorResult>((done) => { finish = done; });
  const { controlled, tasks } = fixture(root, () => pending);
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change" });
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "apply" }), "INVALID_STATE_TRANSITION");
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "INVALID_STATE_TRANSITION");
  finish({ kind: "failed", error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." } });
  await terminal(tasks, generated.taskId);
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "INVALID_STATE_TRANSITION");
});

test("rejects dirty workspaces, changed HEAD, and malformed or out-of-scope patches", async () => {
  const dirtyRoot = repository();
  writeFileSync(join(dirtyRoot, "note.txt"), "dirty\n");
  const dirty = fixture(dirtyRoot, async () => ({ kind: "completed", output: validPatch })).controlled;
  await expectCode(() => dirty.generate({ workspace_id: "workspace", change_request: "change" }), "WORKSPACE_PRECONDITION_FAILED");

  for (const output of ["```diff\n" + validPatch + "```", validPatch.replaceAll("note.txt", "new.txt")]) {
    const root = repository();
    const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output }));
    const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change" });
    await terminal(tasks, generated.taskId);
    await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
  }

  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({ kind: "completed", output: validPatch }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change" });
  await terminal(tasks, generated.taskId);
  writeFileSync(join(root, "other.txt"), "commit\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-qm", "move head");
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
});
