import assert from "node:assert/strict";
import test from "node:test";

import type { Executor, ExecutorRequest } from "../../../src/executors/executor.js";
import { RegisteredWorkspaceTaskService } from "../../../src/tasks/registered-workspace-task-service.js";
import { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const ROOT = "/registered/root";

function registry(): RegisteredWorkspaceRegistry {
  return new RegisteredWorkspaceRegistry(
    [{ id: "known", root: ROOT, allowedBranches: ["main"], requireClean: true }],
    async (_root, args) => {
      if (args.includes("--show-toplevel")) return `${ROOT}\n`;
      if (args.includes("--is-inside-work-tree")) return "true\n";
      if (args[0] === "symbolic-ref") return "main\n";
      return "";
    },
    { lstat: async () => ({ isSymbolicLink: () => false }), realpath: async (path) => path }
  );
}

test("uses one generated id and preserves instruction and output", async () => {
  const calls: ExecutorRequest[] = [];
  let factories = 0;
  const executor: Executor = {
    execute: async (request) => {
      calls.push(request);
      return { kind: "completed", output: "exact output" };
    }
  };
  const service = new RegisteredWorkspaceTaskService(registry(), () => { factories += 1; return executor; });
  const instruction = "  exact instruction\nwith bytes $()  ";
  const snapshot = await service.execute({ workspace_id: "known", instruction });

  assert.equal(snapshot.state, "completed");
  assert.equal(factories, 1);
  assert.deepEqual(calls, [{ taskId: snapshot.id, instruction }]);
  if (snapshot.state === "completed") assert.equal(snapshot.output, "exact output");
});

test("boundary failure keeps the generated id, does not construct executor, and is redacted", async () => {
  let factories = 0;
  const secret = "/secret/unregistered/path";
  const service = new RegisteredWorkspaceTaskService(registry(), () => {
    factories += 1;
    throw new Error(secret);
  });
  const snapshot = await service.execute({ workspace_id: secret, instruction: "x" });

  assert.equal(factories, 0);
  assert.equal(snapshot.state, "failed");
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
  if (snapshot.state === "failed") {
    assert.deepEqual(snapshot.error, {
      code: "UNKNOWN_WORKSPACE", message: "The requested workspace is not registered.", retryable: false
    });
  }
});
