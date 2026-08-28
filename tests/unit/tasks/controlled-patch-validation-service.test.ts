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

  async run(request: ValidationProcessRequest): Promise<ValidationProcessOutcome> {
    this.invocations.push(request);
    return this.overrides.get(request.argv.join(" ")) ?? DEFAULT_OUTCOME;
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
    undefined,
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
  assert.equal(report.steps.length, 2);
  const installStep = report.steps[0];
  assert.equal(installStep?.name, "install");
  assert.equal(installStep?.status, "PASS");
  const failingStep = report.steps[1];
  assert.equal(failingStep?.name, "test");
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
