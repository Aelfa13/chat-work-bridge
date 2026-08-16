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
import { ManagedWorkspaceCatalog } from "../../../src/workspaces/managed-workspace-catalog.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";
import { WorkspaceOnboardingService } from "../../../src/workspaces/workspace-onboarding-service.js";

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

function fixture(
  root: string,
  execute: Executor["execute"],
  startProcess?: GitStarter,
  stateFilePath?: string
): {
  controlled: ControlledPatchService;
  tasks: RegisteredWorkspaceTaskService;
} {
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute }));
  const controlled = stateFilePath === undefined
    ? startProcess === undefined
      ? new ControlledPatchService(registry, tasks)
      : new ControlledPatchService(registry, tasks, startProcess)
    : new ControlledPatchService(registry, tasks, startProcess ?? spawn, stateFilePath);
  return { controlled, tasks };
}

function retainedStateFile(): string {
  return join(mkdtempSync(join(tmpdir(), "engineering-bridge-state-")), "controlled-patches.json");
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

test("restores a completed generated proposal for task_result after restart", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(first.tasks, generated.taskId);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();

  assert.deepEqual(restarted.tasks.taskView(generated.taskId), {
    taskId: generated.taskId,
    state: "completed",
    executor: "codex",
    ready: true,
    output: validPatch
  });
});

test("refines a restored proposal with its parent relationship and original base HEAD retained", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const source = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(first.tasks, source.taskId);

  const refinedPatch = validPatch.replace("+after", "+refined after");
  const restarted = fixture(
    root,
    async () => ({ kind: "completed", output: refinedPatch }),
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  const refined = await restarted.controlled.refine({
    patch_task_id: source.taskId,
    change_request: "improve wording"
  });
  await terminal(restarted.tasks, refined.taskId);

  assert.equal(refined.baseHead, source.baseHead);
  assert.deepEqual(restarted.tasks.result(source.taskId), {
    id: source.taskId,
    state: "completed",
    output: validPatch
  });
  const state = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; base_head: string; parent_task_id?: string }>;
  };
  const retainedSource = state.proposals.find(({ task_id }) => task_id === source.taskId);
  const retainedRefinement = state.proposals.find(({ task_id }) => task_id === refined.taskId);
  assert.equal(retainedSource?.base_head, source.baseHead);
  assert.equal(retainedRefinement?.base_head, source.baseHead);
  assert.equal(retainedRefinement?.parent_task_id, source.taskId);
});

test("applies a refined proposal after restart without rerunning generation", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  let executions = 0;
  const refinedPatch = validPatch.replace("+after", "+refined after");
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: executions++ === 0 ? validPatch : refinedPatch }),
    undefined,
    stateFilePath
  );
  const source = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(first.tasks, source.taskId);
  const refined = await first.controlled.refine({
    patch_task_id: source.taskId,
    change_request: "improve wording"
  });
  await terminal(first.tasks, refined.taskId);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  const applied = await restarted.controlled.apply({
    patch_task_id: refined.taskId,
    confirmation: "APPLY"
  });

  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "refined after\n");
});

test("fails safely on malformed retained state", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  writeFileSync(stateFilePath, "{not json}\n");
  const restarted = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );

  await expectCode(() => restarted.controlled.load(), "INTERNAL_ERROR");
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "before\n");
  assert.equal(readFileSync(stateFilePath, "utf8"), "{not json}\n");
});

test("reports a retention write failure instead of exposing an unretained completed proposal", async () => {
  const root = repository();
  const stateFilePath = join(retainedStateFile(), "missing", "controlled-patches.json");
  const current = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const generated = await current.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(current.tasks, generated.taskId);

  assert.deepEqual(current.tasks.result(generated.taskId), {
    id: generated.taskId,
    state: "failed",
    error: {
      code: "INTERNAL_ERROR",
      message: "The request could not be completed."
    }
  });
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "before\n");
});

test("recovers an interrupted applying proposal as retryable after restart", async () => {
  const root = repository();
  const stateFilePath = retainedStateFile();
  const first = fixture(
    root,
    async () => ({ kind: "completed", output: validPatch }),
    undefined,
    stateFilePath
  );
  const generated = await first.controlled.generate({
    workspace_id: "workspace",
    change_request: "change note"
  });
  await terminal(first.tasks, generated.taskId);

  const state = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
    proposals: Array<{ task_id: string; state: string }>;
  };
  const retainedProposal = state.proposals.find(({ task_id }) => task_id === generated.taskId);
  assert.ok(retainedProposal);
  retainedProposal.state = "applying";
  writeFileSync(stateFilePath, `${JSON.stringify(state, null, 2)}\n`);

  const restarted = fixture(
    root,
    async () => { throw new Error("restored tasks must not execute"); },
    undefined,
    stateFilePath
  );
  await restarted.controlled.load();
  const proposals = (restarted.controlled as unknown as {
    proposals: Map<string, { state: string }>;
  }).proposals;
  assert.equal(proposals.get(generated.taskId)?.state, "proposed");

  const applied = await restarted.controlled.apply({
    patch_task_id: generated.taskId,
    confirmation: "APPLY"
  });
  assert.deepEqual(applied.changed_paths, ["note.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "after\n");
});

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

test("refines a complete multi-file proposal without changing its source and applies the complete replacement", async () => {
  const root = repository();
  const sourcePatch = `${validPatch}${additionPatch}`;
  const refinedPatch = sourcePatch
    .replace("+after\n", "+refined\n")
    .replace("+added\n", "+refined added\n");
  const instructions: string[] = [];
  const { controlled, tasks } = fixture(root, async (request) => {
    instructions.push(request.instruction);
    return { kind: "completed", output: instructions.length === 1 ? sourcePatch : refinedPatch };
  });

  const source = await controlled.generate({ workspace_id: "workspace", change_request: "implement original multi-file change" });
  await terminal(tasks, source.taskId);
  const sourceResult = tasks.result(source.taskId);
  const refined = await controlled.refine({
    patch_task_id: source.taskId,
    change_request: "fix note wording"
  });
  await terminal(tasks, refined.taskId);

  assert.notEqual(refined.taskId, source.taskId);
  assert.equal(refined.baseHead, source.baseHead);
  const refinementInstruction = instructions[1]!;
  assert.ok(refinementInstruction.includes(sourcePatch));
  assert.match(refinementInstruction, /Treat the source proposal below as the reviewed baseline/);
  assert.match(refinementInstruction, /Fix only the requested issues and preserve all unrelated proposal semantics/);
  assert.match(refinementInstruction, /COMPLETE final unified diff relative to the SAME original base_head/);
  assert.match(refinementInstruction, /not an incremental patch against the source proposal/);
  assert.doesNotMatch(refinementInstruction, /implement original multi-file change/);
  assert.deepEqual(tasks.result(source.taskId), sourceResult);

  const applied = await controlled.apply({ patch_task_id: refined.taskId, confirmation: "APPLY" });
  assert.deepEqual(applied.changed_paths, ["note.txt", "added.txt"]);
  assert.equal(readFileSync(join(root, "note.txt"), "utf8"), "refined\n");
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "refined added\n");
});

test("rejects missing, non-completed, and HEAD-drifted refinement sources without starting Codex", async () => {
  const root = repository();
  let finish!: (result: ExecutorResult) => void;
  const pending = new Promise<ExecutorResult>((done) => { finish = done; });
  let executions = 0;
  const { controlled, tasks } = fixture(root, () => {
    executions += 1;
    return pending;
  });
  const source = await controlled.generate({ workspace_id: "workspace", change_request: "change note" });
  await Promise.resolve();

  await expectCode(() => controlled.refine({
    patch_task_id: "missing",
    change_request: "refine"
  }), "INVALID_STATE_TRANSITION");
  await expectCode(() => controlled.refine({
    patch_task_id: source.taskId,
    change_request: "refine"
  }), "INVALID_STATE_TRANSITION");
  assert.equal(executions, 1);

  finish({ kind: "completed", output: validPatch });
  await terminal(tasks, source.taskId);
  writeFileSync(join(root, "other.txt"), "commit\n");
  git(root, "add", "other.txt");
  git(root, "commit", "-qm", "move head");
  await expectCode(() => controlled.refine({
    patch_task_id: source.taskId,
    change_request: "refine"
  }), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(executions, 1);
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

test("removes a proposal when its controlled patch generation task fails", async () => {
  const root = repository();
  const { controlled, tasks } = fixture(root, async () => ({
    kind: "failed",
    error: { code: "CODEX_EXECUTION_FAILED", message: "Codex execution failed." }
  }));
  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "change" });
  await terminal(tasks, generated.taskId);

  const proposals = (controlled as unknown as { proposals: Map<string, { state: string }> }).proposals;
  assert.equal(proposals.has(generated.taskId), false);
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

test("bounds applied proposal history without evicting live proposed or applying proposals", async () => {
  const root = repository();
  let next = 0;
  const { controlled, tasks } = fixture(root, async () => {
    const path = `added-${next++}.txt`;
    return { kind: "completed", output: additionPatch.replaceAll("added.txt", path) };
  });
  const appliedTaskIds: string[] = [];

  for (let index = 0; index < 101; index += 1) {
    const proposal = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
    await terminal(tasks, proposal.taskId);
    await controlled.apply({ patch_task_id: proposal.taskId, confirmation: "APPLY" });
    appliedTaskIds.push(proposal.taskId);
    git(root, "add", ".");
    git(root, "commit", "-qm", `apply ${index}`);
  }

  const proposals = (controlled as unknown as { proposals: Map<string, { state: string }> }).proposals;
  assert.equal(proposals.has(appliedTaskIds[0]!), false);
  for (const taskId of appliedTaskIds.slice(1)) assert.equal(proposals.get(taskId)?.state, "applied");

  const live = await controlled.generate({ workspace_id: "workspace", change_request: "add live file" });
  const applying = await controlled.generate({ workspace_id: "workspace", change_request: "add applying file" });
  proposals.get(applying.taskId)!.state = "applying";
  assert.equal(proposals.size, 102);

  await terminal(tasks, live.taskId);
  assert.equal((await controlled.apply({ patch_task_id: live.taskId, confirmation: "APPLY" })).applied, true);
  assert.equal(proposals.get(applying.taskId)?.state, "applying");
});

test("generates and refines proposals for an unborn repository with an explicit unborn instruction", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const instructions: string[] = [];
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async (request) => {
      instructions.push(request.instruction);
      return { kind: "completed", output: additionPatch };
    }
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
  assert.equal(generated.baseHead, null);
  await terminal(tasks, generated.taskId);
  const generateInstruction = instructions[0] ?? "";
  assert.match(generateInstruction, /unborn repository state/u);
  assert.match(generateInstruction, /only add ordinary text files using new file mode 100644/u);
  // No fake HEAD: never "Base HEAD: null" or a fabricated SHA. (The embedded
  // source diff legitimately contains "/dev/null" headers.)
  assert.equal(generateInstruction.includes("Base HEAD: null"), false);
  assert.equal(/\bbase_head\s+null\b/u.test(generateInstruction), false);
  assert.equal(/\b[0-9a-f]{40}\b/u.test(generateInstruction), false);

  const refined = await controlled.refine({ patch_task_id: generated.taskId, change_request: "adjust" });
  assert.equal(refined.baseHead, null);
  await terminal(tasks, refined.taskId);
  const refinementInstruction = instructions[1] ?? "";
  assert.match(refinementInstruction, /unborn repository state/u);
  assert.match(refinementInstruction, /only add ordinary text files using new file mode 100644/u);
  assert.equal(refinementInstruction.includes("Base HEAD: null"), false);
  assert.equal(/\bbase_head\s+null\b/u.test(refinementInstruction), false);
  assert.equal(/\b[0-9a-f]{40}\b/u.test(refinementInstruction), false);
});

test("applies an unborn proposal while the repository stays unborn and does not stage files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
  await terminal(tasks, generated.taskId);
  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });

  assert.equal(applied.applied, true);
  assert.deepEqual(applied.changed_paths, ["added.txt"]);
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");
  // git apply without --index never stages the new file.
  assert.equal(git(root, "ls-files", "--stage").trim(), "");
});

test("rejects an unborn proposal once the repository gains its first commit", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const generated = await controlled.generate({ workspace_id: "workspace", change_request: "add file" });
  await terminal(tasks, generated.taskId);
  writeFileSync(join(root, "seed.txt"), "seed\n");
  git(root, "add", "seed.txt");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "commit", "-qm", "first commit");

  // Both refine and APPLY must reject the stale unborn proposal.
  await expectCode(() => controlled.refine({ patch_task_id: generated.taskId, change_request: "adjust" }), "WORKSPACE_PRECONDITION_FAILED");
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
});

test("rejects unborn modified targets and targets that already exist as untracked files", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks);

  const modified = await controlled.generate({ workspace_id: "workspace", change_request: "modify" });
  await terminal(tasks, modified.taskId);
  await expectCode(() => controlled.apply({ patch_task_id: modified.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");

  const conflictingTasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  const conflicting = new ControlledPatchService(registry, conflictingTasks);
  const generated = await conflicting.generate({ workspace_id: "workspace", change_request: "add file" });
  await terminal(conflictingTasks, generated.taskId);
  writeFileSync(join(root, "added.txt"), "user content\n");
  await expectCode(() => conflicting.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");
});

test("retained-state loader accepts old and new commit bases and rejects illegal base combinations", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const head = git(root, "rev-parse", "HEAD").trim();
  const stateFilePath = retainedStateFile();
  const oldRecord = {
    version: 1,
    applied_task_ids: [],
    proposals: [{
      task_id: "00000000-0000-4000-8000-000000000001",
      workspace_id: "workspace",
      workspace_root: root,
      base_head: head,
      state: "proposed",
      output: validPatch
    }]
  };
  writeFileSync(stateFilePath, `${JSON.stringify(oldRecord, null, 2)}\n`);
  const oldTasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute: async () => ({ kind: "completed", output: validPatch }) }));
  const oldLoaded = new ControlledPatchService(registry, oldTasks, undefined, stateFilePath);
  await oldLoaded.load();
  const oldProposals = (oldLoaded as unknown as { proposals: Map<string, { base: { kind: string; head?: string } }> }).proposals;
  assert.equal(oldProposals.get("00000000-0000-4000-8000-000000000001")?.base.kind, "commit");

  const newCommitRecord = {
    ...oldRecord,
    proposals: [{ ...oldRecord.proposals[0]!, unborn: false }]
  };
  writeFileSync(stateFilePath, `${JSON.stringify(newCommitRecord, null, 2)}\n`);
  const newCommitTasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute: async () => ({ kind: "completed", output: validPatch }) }));
  const newCommitLoaded = new ControlledPatchService(registry, newCommitTasks, undefined, stateFilePath);
  await newCommitLoaded.load();
  assert.equal(
    (newCommitLoaded as unknown as { proposals: Map<string, { base: { kind: string; head?: string } }> }).proposals
      .get("00000000-0000-4000-8000-000000000001")?.base.kind,
    "commit"
  );

  const unbornRoot = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-state-")));
  git(unbornRoot, "init", "-q");
  const unbornStateFilePath = retainedStateFile();
  writeFileSync(unbornStateFilePath, `${JSON.stringify({
    version: 1,
    applied_task_ids: [],
    proposals: [{
      task_id: "00000000-0000-4000-8000-000000000002",
      workspace_id: "unborn-workspace",
      workspace_root: unbornRoot,
      base_head: null,
      unborn: true,
      state: "proposed",
      output: additionPatch
    }]
  }, null, 2)}\n`);
  const unbornRegistry = new RegisteredWorkspaceRegistry([{ id: "unborn-workspace", root: unbornRoot, allow_write: true }]);
  const unbornTasks = new RegisteredWorkspaceTaskService(unbornRegistry, () => ({ execute: async () => ({ kind: "completed", output: additionPatch }) }));
  const unbornLoaded = new ControlledPatchService(unbornRegistry, unbornTasks, undefined, unbornStateFilePath);
  await unbornLoaded.load();
  assert.equal(
    (unbornLoaded as unknown as { proposals: Map<string, { base: { kind: string } }> }).proposals
      .get("00000000-0000-4000-8000-000000000002")?.base.kind,
    "unborn"
  );

  // Restart recovery: the restored unborn proposal can still be refined and applied.
  const refined = await unbornLoaded.refine({ patch_task_id: "00000000-0000-4000-8000-000000000002", change_request: "adjust" });
  assert.equal(refined.baseHead, null);
  await terminal(unbornTasks, refined.taskId);
  const restoredApplied = await unbornLoaded.apply({ patch_task_id: refined.taskId, confirmation: "APPLY" });
  assert.equal(restoredApplied.applied, true);
  assert.equal(readFileSync(join(unbornRoot, "added.txt"), "utf8"), "added\n");

  for (const [baseHead, unborn] of [[null, false], [head, true], [null, undefined]] as const) {
    // JSON.stringify drops the undefined key: [null, undefined] is exactly the
    // "base_head null with no unborn field" illegal combination.
    writeFileSync(stateFilePath, `${JSON.stringify({
      version: 1,
      applied_task_ids: [],
      proposals: [{
        task_id: "00000000-0000-4000-8000-000000000003",
        workspace_id: "workspace",
        workspace_root: root,
        base_head: baseHead,
        unborn,
        state: "proposed",
        output: validPatch
      }]
    }, null, 2)}\n`);
    const invalidTasks = new RegisteredWorkspaceTaskService(registry, () => ({ execute: async () => ({ kind: "completed", output: validPatch }) }));
    const invalid = new ControlledPatchService(registry, invalidTasks, undefined, stateFilePath);
    await expectCode(() => invalid.load(), "INTERNAL_ERROR");
  }
});

test("generation needs no write authorization; APPLY does, and AUTHORIZE afterwards enables the same proposal", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([]);
  const catalog = new ManagedWorkspaceCatalog(undefined);
  await catalog.load();
  const { id } = await catalog.registerOnce(root);
  registry.registerManaged(id, root);
  const onboarding = new WorkspaceOnboardingService(registry, catalog, []);
  const stateFilePath = retainedStateFile();
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks, undefined, stateFilePath);

  // Any registered workspace can generate a read-only proposal.
  const generated = await controlled.generate({ workspace_id: id, change_request: "add file" });
  assert.equal(generated.baseHead, git(root, "rev-parse", "HEAD").trim());
  await terminal(tasks, generated.taskId);

  // Refinement is also read-only analysis: no write authorization needed.
  const refined = await controlled.refine({ patch_task_id: generated.taskId, change_request: "adjust" });
  assert.equal(refined.baseHead, git(root, "rev-parse", "HEAD").trim());
  await terminal(tasks, refined.taskId);

  // APPLY still requires controlled-write authorization.
  await expectCode(() => controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" }), "WORKSPACE_PRECONDITION_FAILED");

  // AUTHORIZE the managed workspace, then the SAME proposal applies.
  const authorized = await onboarding.authorizeWrite(id);
  assert.deepEqual(authorized, { workspace_id: id, allow_write: true });
  assert.equal(registry.resolveWritable(id), root);
  const applied = await controlled.apply({ patch_task_id: generated.taskId, confirmation: "APPLY" });
  assert.equal(applied.applied, true);
  assert.equal(readFileSync(join(root, "added.txt"), "utf8"), "added\n");

  // Restart recovery: the authorized state round-trips through the catalog and registry.
  const reloadedRegistry = new RegisteredWorkspaceRegistry([]);
  for (const entry of catalog.entries()) reloadedRegistry.registerManaged(entry.id, entry.root, entry.allowWrite);
  assert.equal(reloadedRegistry.resolveWritable(id), root);
});

test("HEAD detection fails closed: a git helper spawn failure in a real unborn repo is not inferred as unborn", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  // The repository is genuinely unborn, but the HEAD probe cannot even spawn:
  // that must fail closed, never be guessed as unborn.
  const starter: GitStarter = (executable, args, options) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet" && args[3] === "HEAD") {
      throw new Error("simulated git spawn failure");
    }
    return spawn(executable, args, options);
  };
  const controlled = new ControlledPatchService(registry, tasks, starter);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "add file" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("HEAD detection fails closed: a nonzero rev-parse without unborn proof is not inferred as unborn", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  // rev-parse HEAD exits non-zero exactly as in an unborn repo, but the branch
  // symbolic ref resolves to a real commit: an inconsistent reference state,
  // not an unborn branch.
  const starter: GitStarter = (executable, args, options) => {
    if (args[0] === "rev-parse" && args[1] === "--verify" && args[2] === "--quiet" && args[3] === "HEAD") {
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(executable, args, options);
  };
  const controlled = new ControlledPatchService(registry, tasks, starter);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "change note" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("HEAD detection fails closed: a detached-style unresolvable HEAD is not inferred as unborn", async () => {
  const root = repository();
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: validPatch })
  }));
  // HEAD cannot resolve and there is no symbolic branch ref behind it (as with
  // a missing or detached HEAD): without a branch ref, unborn is unproven.
  const starter: GitStarter = (executable, args, options) => {
    if (args.includes("--quiet")) {
      return spawn(process.execPath, ["-e", "process.exit(1)"], options);
    }
    return spawn(executable, args, options);
  };
  const controlled = new ControlledPatchService(registry, tasks, starter);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "change note" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});

test("HEAD detection fails closed: a non-branch symbolic HEAD is not inferred as unborn", async () => {
  // A real repository whose HEAD symbolic ref points outside refs/heads/: git
  // reports no resolvable HEAD, but this is not an unborn branch state.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "engineering-bridge-unborn-")));
  git(root, "init", "-q");
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/tags/nonexistent\n");
  const registry = new RegisteredWorkspaceRegistry([{ id: "workspace", root, allow_write: true }]);
  const tasks = new RegisteredWorkspaceTaskService(registry, () => ({
    execute: async () => ({ kind: "completed", output: additionPatch })
  }));
  const controlled = new ControlledPatchService(registry, tasks);
  await expectCode(
    () => controlled.generate({ workspace_id: "workspace", change_request: "add file" }),
    "WORKSPACE_PRECONDITION_FAILED"
  );
});
