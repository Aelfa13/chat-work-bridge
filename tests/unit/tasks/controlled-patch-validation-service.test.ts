import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CoreError } from "../../../src/core/errors.js";
import type {
  ControlledPatchService,
  ControlledPatchValidationProposal
} from "../../../src/tasks/controlled-patch-service.js";
import {
  ControlledPatchValidationService
} from "../../../src/tasks/controlled-patch-validation-service.js";
import type {
  ValidationProfile,
  ValidationProfileStore
} from "../../../src/tasks/validation-profile-store.js";
import type {
  ValidationProcessOutcome,
  ValidationProcessRequest,
  ValidationProcessRunner
} from "../../../src/tasks/validation-process-runner.js";
import type { RegisteredWorkspaceRegistry } from "../../../src/workspaces/registered-workspace-registry.js";

const COMMIT_PROPOSAL: ControlledPatchValidationProposal = {
  workspaceId: "workspace-a",
  workspaceRoot: "/workspaces/workspace-a",
  baseHead: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
  patch: [
    "diff --git a/note.txt b/note.txt",
    "index 5f24e3d..2f1a4b9 100644",
    "--- a/note.txt",
    "+++ b/note.txt",
    "@@ -1 +1 @@",
    "-before",
    "+after"
  ].join("\n")
};

const UNBORN_PROPOSAL: ControlledPatchValidationProposal = {
  ...COMMIT_PROPOSAL,
  baseHead: null
};

const PROFILE: ValidationProfile = {
  preparation: [
    { name: "install", argv: ["npm", "ci", "--ignore-scripts"] },
    { name: "build", argv: ["npm", "run", "build"] }
  ],
  validation: [
    { name: "test", argv: ["npm", "test"], timeoutSeconds: 90 },
    { name: "lint", argv: ["npm", "run", "lint"] }
  ],
  defaultStepTimeoutSeconds: 600,
  totalTimeoutSeconds: 1200
};

const DEFAULT_OUTCOME: ValidationProcessOutcome = {
  kind: "exit",
  exitCode: 0,
  durationMs: 1,
  outputTail: ""
};

class FakeControlledPatchService {
  preflightError: unknown = undefined;
  preflightCalls = 0;

  constructor(readonly proposal: ControlledPatchValidationProposal) {}

  validationProposal(_patchTaskId: string): ControlledPatchValidationProposal {
    return this.proposal;
  }

  async preflightValidationProposal(
    _patchTaskId: string
  ): Promise<ControlledPatchValidationProposal> {
    this.preflightCalls++;
    if (this.preflightError !== undefined) {
      throw this.preflightError;
    }
    return this.proposal;
  }
}

class FakeProfileStore {
  getCalls = 0;

  constructor(readonly profile: ValidationProfile | undefined) {}

  async get(_workspaceId: string): Promise<ValidationProfile | undefined> {
    this.getCalls++;
    return this.profile;
  }
}

class FakeValidationProcessRunner {
  readonly invocations: ValidationProcessRequest[] = [];
  readonly overrides = new Map<string, ValidationProcessOutcome>();
  readonly prefixOverrides: Array<{
    readonly prefix: string;
    readonly outcome: ValidationProcessOutcome;
  }> = [];

  async run(request: ValidationProcessRequest): Promise<ValidationProcessOutcome> {
    this.invocations.push(request);
    const key = request.argv.join(" ");
    const exact = this.overrides.get(key);
    if (exact !== undefined) {
      return exact;
    }
    const prefixMatch = this.prefixOverrides.find((entry) =>
      key.startsWith(entry.prefix)
    );
    return prefixMatch?.outcome ?? DEFAULT_OUTCOME;
  }
}

type TempParentFactory = (() => Promise<string>) & {
  readonly created: readonly string[];
};

function makeTempParent(): TempParentFactory {
  const created: string[] = [];
  const factory = async (): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "engineering-bridge-validation-"));
    created.push(dir);
    return dir;
  };
  return Object.assign(factory, { created });
}

interface ValidationHarness {
  service: ControlledPatchValidationService;
  patches: FakeControlledPatchService;
  store: FakeProfileStore;
  runner: FakeValidationProcessRunner;
  tempParent: TempParentFactory;
}

function makeHarness(options: {
  proposal: ControlledPatchValidationProposal;
  profile: ValidationProfile | undefined;
  preflightError?: unknown;
  runnerOverrides?: ReadonlyMap<string, ValidationProcessOutcome>;
  nowMs?: () => number;
}): ValidationHarness {
  const patches = new FakeControlledPatchService(options.proposal);
  if (options.preflightError !== undefined) {
    patches.preflightError = options.preflightError;
  }
  const store = new FakeProfileStore(options.profile);
  const runner = new FakeValidationProcessRunner();
  for (const [command, outcome] of options.runnerOverrides ?? []) {
    runner.overrides.set(command, outcome);
  }
  const tempParent = makeTempParent();
  const registry = {
    resolve: (workspaceId: string) => "/workspaces/" + workspaceId
  } as unknown as RegisteredWorkspaceRegistry;
  const service = new ControlledPatchValidationService(
    registry,
    patches as unknown as ControlledPatchService,
    store as unknown as ValidationProfileStore,
    runner as unknown as ValidationProcessRunner,
    options.nowMs,
    tempParent
  );
  return { service, patches, store, runner, tempParent };
}

test("validate is INCOMPLETE with validation_profile_missing when no profile exists, without starting processes or temp state", async () => {
  const harness = makeHarness({ proposal: COMMIT_PROPOSAL, profile: undefined });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.reason, "validation_profile_missing");
  assert.equal(report.cleanup, "success");
  assert.equal(harness.patches.preflightCalls, 0);
  assert.equal(harness.runner.invocations.length, 0);
  assert.equal(harness.tempParent.created.length, 0);
});

test("validate is INCOMPLETE with unsupported_unborn_base for a retained unborn proposal before preflight, worktree, or processes", async () => {
  const harness = makeHarness({ proposal: UNBORN_PROPOSAL, profile: PROFILE });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.reason, "unsupported_unborn_base");
  assert.equal(report.cleanup, "success");
  assert.equal(harness.patches.preflightCalls, 0);
  assert.equal(harness.runner.invocations.length, 0);
  assert.equal(harness.tempParent.created.length, 0);
});

test("validate is INCOMPLETE with preflight_failed when the shared preflight fails, without starting worktree or processes", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    preflightError: new CoreError("WORKSPACE_PRECONDITION_FAILED")
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.reason, "preflight_failed");
  assert.equal(report.cleanup, "success");
  assert.equal(harness.patches.preflightCalls, 1);
  assert.equal(harness.runner.invocations.length, 0);
  assert.equal(harness.tempParent.created.length, 0);
});

test("validate is FAIL when a preparation step exits nonzero and later configured steps are not started", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm ci --ignore-scripts", {
        kind: "exit",
        exitCode: 7,
        durationMs: 5,
        outputTail: "install failed"
      }]
    ])
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "FAIL");
  assert.equal(report.cleanup, "success");
  assert.equal(report.steps.length, 1);
  const failingStep = report.steps[0];
  assert.equal(failingStep?.name, "install");
  assert.equal(failingStep?.status, "FAIL");
  assert.equal(failingStep?.exit_code, 7);
  assert.equal(failingStep?.output_tail, "install failed");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(!started.includes("npm run build"));
  assert.ok(!started.includes("npm test"));
});

test("validate is FAIL when a validation step exits nonzero and later configured steps are not started", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm test", {
        kind: "exit",
        exitCode: 3,
        durationMs: 4,
        outputTail: "1 test failed"
      }]
    ])
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "FAIL");
  assert.equal(report.cleanup, "success");
  assert.equal(report.steps.length, 3);
  const installStep = report.steps[0];
  assert.equal(installStep?.name, "install");
  assert.equal(installStep?.status, "PASS");
  const buildStep = report.steps[1];
  assert.equal(buildStep?.name, "build");
  assert.equal(buildStep?.status, "PASS");
  const failingStep = report.steps[2];
  assert.equal(failingStep?.name, "test");
  assert.equal(failingStep?.status, "FAIL");
  assert.equal(failingStep?.exit_code, 3);
  assert.equal(failingStep?.output_tail, "1 test failed");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(started.includes("npm run build"));
  assert.ok(started.includes("npm test"));
  assert.ok(!started.includes("npm run lint"));
});

test("validate is INCOMPLETE when a configured step times out and later configured steps are not started", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm test", {
        kind: "timeout",
        durationMs: 90_000,
        outputTail: "test timed out"
      }]
    ])
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "success");
  const timedOutStep = report.steps.find((step) => step.name === "test");
  assert.equal(timedOutStep?.status, "INCOMPLETE");
  assert.equal(timedOutStep?.duration_ms, 90_000);
  assert.equal(timedOutStep?.output_tail, "test timed out");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(started.includes("npm run build"));
  assert.ok(started.includes("npm test"));
  assert.ok(!started.includes("npm run lint"));
});

test("validate is INCOMPLETE when a configured step fails to spawn and later configured steps are not started", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm run build", {
        kind: "spawn_error",
        durationMs: 1,
        outputTail: ""
      }]
    ])
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "success");
  const failedToSpawnStep = report.steps.find((step) => step.name === "build");
  assert.equal(failedToSpawnStep?.status, "INCOMPLETE");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(started.includes("npm run build"));
  assert.ok(!started.includes("npm test"));
  assert.ok(!started.includes("npm run lint"));
});

test("validate is INCOMPLETE when a configured step is terminated by a signal and later configured steps are not started", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm test", {
        kind: "signal",
        durationMs: 4,
        outputTail: "terminated by SIGKILL"
      }]
    ])
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "success");
  const signaledStep = report.steps.find((step) => step.name === "test");
  assert.equal(signaledStep?.status, "INCOMPLETE");
  assert.equal(signaledStep?.output_tail, "terminated by SIGKILL");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(started.includes("npm run build"));
  assert.ok(started.includes("npm test"));
  assert.ok(!started.includes("npm run lint"));
});

test("validate is INCOMPLETE with failed cleanup when cleanup fails after all steps pass, preserving step evidence", async () => {
  const harness = makeHarness({ proposal: COMMIT_PROPOSAL, profile: PROFILE });
  harness.runner.prefixOverrides.push({
    prefix: "git -C /workspaces/workspace-a worktree remove --force",
    outcome: {
      kind: "exit",
      exitCode: 1,
      durationMs: 2,
      outputTail: "worktree not found"
    }
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "failed");
  assert.equal(report.steps.length, 4);
  assert.deepEqual(
    report.steps.map((step) => [step.name, step.status]),
    [
      ["install", "PASS"],
      ["build", "PASS"],
      ["test", "PASS"],
      ["lint", "PASS"]
    ]
  );
});

test("validate is INCOMPLETE with failed cleanup when cleanup fails after a step fails, preserving the failing step evidence", async () => {
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    runnerOverrides: new Map([
      ["npm test", {
        kind: "exit",
        exitCode: 3,
        durationMs: 4,
        outputTail: "1 test failed"
      }]
    ])
  });
  harness.runner.prefixOverrides.push({
    prefix: "git -C /workspaces/workspace-a worktree remove --force",
    outcome: {
      kind: "exit",
      exitCode: 1,
      durationMs: 2,
      outputTail: "worktree not found"
    }
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "INCOMPLETE");
  assert.equal(report.cleanup, "failed");
  const failingStep = report.steps.find((step) => step.name === "test");
  assert.equal(failingStep?.status, "FAIL");
  assert.equal(failingStep?.exit_code, 3);
  assert.equal(failingStep?.output_tail, "1 test failed");

  const started = harness.runner.invocations.map((invocation) =>
    invocation.argv.join(" ")
  );
  assert.ok(started.includes("npm ci --ignore-scripts"));
  assert.ok(started.includes("npm test"));
  assert.ok(!started.includes("npm run lint"));
});

test("validate is PASS when preparation, validation, and cleanup all succeed", async () => {
  const harness = makeHarness({ proposal: COMMIT_PROPOSAL, profile: PROFILE });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "PASS");
  assert.equal(report.cleanup, "success");
  assert.deepEqual(
    report.steps.map((step) => [step.name, step.status]),
    [
      ["install", "PASS"],
      ["build", "PASS"],
      ["test", "PASS"],
      ["lint", "PASS"]
    ]
  );
});

test("validate caps each configured step timeout at min(step timeout, remaining total budget) under a deterministic clock", async () => {
  let nowMsCalls = 0;
  const nowMs = () => (nowMsCalls++ === 0 ? 0 : 700_000);
  const harness = makeHarness({
    proposal: COMMIT_PROPOSAL,
    profile: PROFILE,
    nowMs
  });

  const report = await harness.service.validate("task-1");

  assert.equal(report.status, "PASS");
  // Remaining total budget under the deterministic clock:
  // 1200s total - 700s elapsed = 500s = 500_000ms.
  const byArgv = new Map(
    harness.runner.invocations.map((invocation) => [
      invocation.argv.join(" "),
      invocation
    ])
  );
  assert.equal(byArgv.get("npm ci --ignore-scripts")?.timeoutMs, 500_000);
  assert.equal(byArgv.get("npm run build")?.timeoutMs, 500_000);
  assert.equal(byArgv.get("npm test")?.timeoutMs, 90_000);
  assert.equal(byArgv.get("npm run lint")?.timeoutMs, 500_000);
});
