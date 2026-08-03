import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError } from "../../../src/core/errors.js";
import {
  createGitRunner, GIT_ARGUMENT_PREFIX, RegisteredWorkspaceRegistry, trustedWorkspaceRoot
} from "../../../src/workspaces/registered-workspace-registry.js";
import type { GitProcessStarter, GitRunner, WorkspaceRegistration } from "../../../src/workspaces/registered-workspace-registry.js";

const ROOT = "/registered/root";
const registration: WorkspaceRegistration = {
  id: "workspace", root: ROOT, allowedBranches: ["main"], requireClean: true
};

function files(options: { symlink?: boolean; rootRealpath?: string; topRealpath?: string } = {}) {
  return {
    lstat: async () => ({ isSymbolicLink: () => options.symlink ?? false }),
    realpath: async (path: string) => path === ROOT
      ? (options.rootRealpath ?? ROOT)
      : (options.topRealpath ?? path)
  };
}

function git(options: { top?: string; inside?: string; branch?: string; status?: string; fail?: boolean } = {}, calls: readonly string[][][] | string[][] = []): GitRunner {
  return async (_root, args) => {
    (calls as string[][]).push([...args]);
    if (options.fail) throw new Error("secret git failure");
    if (args.includes("--show-toplevel")) return `${options.top ?? ROOT}\n`;
    if (args.includes("--is-inside-work-tree")) return `${options.inside ?? "true"}\n`;
    if (args[0] === "symbolic-ref") return `${options.branch ?? "main"}\n`;
    return options.status ?? "";
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof CoreError && error.code === code);
}

test("signs and freezes a verified runtime capability", async () => {
  const calls: string[][] = [];
  const workspace = await new RegisteredWorkspaceRegistry([registration], git({}, calls), files()).resolve("workspace");
  assert.equal(Object.isFrozen(workspace), true);
  assert.equal(trustedWorkspaceRoot(workspace), ROOT);
  assert.deepEqual(calls.at(-1), ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"]);
});

test("unknown id performs zero probes and configuration cannot be ambiguous", async () => {
  let probes = 0;
  const runner: GitRunner = async () => { probes += 1; return ""; };
  await expectCode(new RegisteredWorkspaceRegistry([registration], runner, files()).resolve("missing"), "UNKNOWN_WORKSPACE");
  assert.equal(probes, 0);
  for (const entries of [
    [registration, { ...registration, root: "/other" }],
    [{ ...registration, id: "" }],
    [{ ...registration, allowedBranches: [] }],
    [{ ...registration, allowedBranches: [""] }]
  ]) {
    assert.throws(() => new RegisteredWorkspaceRegistry(entries, runner, files()), (error: unknown) =>
      error instanceof CoreError && error.code === "WORKSPACE_BOUNDARY_VIOLATION");
  }
});

test("maps path identity failures to boundary violations", async () => {
  const cases = [
    { entry: { ...registration, root: "relative" }, probe: files() },
    { entry: registration, probe: files({ symlink: true }) },
    { entry: registration, probe: files({ rootRealpath: "/different" }) },
    { entry: registration, probe: files({ topRealpath: "/different" }), runner: git({ top: "/top" }) }
  ];
  for (const item of cases) {
    await expectCode(new RegisteredWorkspaceRegistry([item.entry], item.runner ?? git(), item.probe).resolve("workspace"), "WORKSPACE_BOUNDARY_VIOLATION");
  }
});

test("maps Git and repository state failures to precondition failures", async () => {
  for (const runner of [
    git({ fail: true }), git({ inside: "false" }), git({ branch: "" }), git({ branch: "dev" }),
    git({ status: "?? untracked-file\n" })
  ]) {
    await expectCode(new RegisteredWorkspaceRegistry([registration], runner, files()).resolve("workspace"), "WORKSPACE_PRECONDITION_FAILED");
  }
});

interface Invocation { executable: string; args: readonly string[]; options: SpawnOptionsWithoutStdio; killed: boolean }
function processStarter(invocations: Invocation[], output: string, close = true): GitProcessStarter {
  return (executable, args, options) => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const invocation = { executable, args: [...args], options, killed: false };
    Object.assign(child, { stdin, stdout, stderr, kill: () => { invocation.killed = true; return true; } });
    invocations.push(invocation);
    queueMicrotask(() => { stdout.write(output); if (close) child.emit("close", 0, null); });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

test("Git runner fixes invocation, isolated environment, timeout, and stdout bound", async () => {
  const invocations: Invocation[] = [];
  const host = { PATH: "/bin", TMPDIR: "/tmp", LANG: "C", LC_ALL: "C", HOME: "/secret", HTTP_PROXY: "secret" };
  const runner = createGitRunner({ startProcess: processStarter(invocations, "ok"), hostEnvironment: host });
  assert.equal(await runner(ROOT, ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames"]), "ok");
  const invocation = invocations[0]; assert.ok(invocation);
  assert.equal(invocation.executable, "git");
  assert.deepEqual(invocation.args, [...GIT_ARGUMENT_PREFIX, "status", "--porcelain=v1", "--untracked-files=all", "--no-renames"]);
  assert.equal(invocation.options.shell, false); assert.equal(invocation.options.cwd, ROOT);
  assert.deepEqual(invocation.options.env, {
    PATH: "/bin", TMPDIR: "/tmp", LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0"
  });

  const timed: Invocation[] = [];
  await expectCode(createGitRunner({ startProcess: processStarter(timed, "", false), timeoutMs: 1 })(ROOT, ["x"]), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(timed[0]?.killed, true);
  const overflowed: Invocation[] = [];
  await expectCode(createGitRunner({ startProcess: processStarter(overflowed, "four"), stdoutLimitBytes: 3 })(ROOT, ["x"]), "WORKSPACE_PRECONDITION_FAILED");
  assert.equal(overflowed[0]?.killed, true);
});
