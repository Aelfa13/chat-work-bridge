import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";

import { CoreError } from "../core/errors.js";
import { isId } from "../core/ids.js";
import type { Id } from "../core/ids.js";
import { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";
import { RegisteredWorkspaceTaskService } from "./registered-workspace-task-service.js";

export type GitStarter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

// Minimal exit-code-observing git result: the caller must be able to tell a
// genuine failure from an expected nonzero exit (HEAD detection only).
type GitExit = { readonly code: number; readonly stdout: string };

export type ProposalBase =
  | { readonly kind: "commit"; readonly head: string }
  | { readonly kind: "unborn" };

type Proposal = {
  workspaceId: string;
  workspaceRoot: string;
  base: ProposalBase;
  state: "proposed" | "applying" | "applied";
  parentTaskId: Id | undefined;
  output: string | undefined;
};

type RetainedProposal = Proposal & { taskId: Id; output: string };
type RetainedState = { proposals: RetainedProposal[]; appliedTaskIds: Id[] };

const CONTROLLED_PATCH_STATE_VERSION = 1;
const MAX_APPLIED_PROPOSAL_HISTORY = 100;

const PATCH_INSTRUCTION = (changeRequest: string, base: ProposalBase): string => {
  const scope = base.kind === "unborn"
    ? "The workspace is a newly created Git repository with no commits yet (unborn repository state). There are no tracked files to modify, so the proposed change must only add ordinary text files using new file mode 100644."
    : "Modify existing tracked regular text files, or add ordinary text files using new file mode 100644.";
  return `You are preparing a proposed change for human review. The workspace is read-only.
Return only a unified textual Git diff for the requested change, beginning with "diff --git". Do not use Markdown fences or commentary. Do not include binary patches, deletions, renames or copies, mode changes, symlinks, or submodules. ${scope}

Change request:
${changeRequest}`;
};

const REFINEMENT_INSTRUCTION = (base: ProposalBase, sourceDiff: string, changeRequest: string): string => {
  const baseClause = base.kind === "commit"
    ? `Output a COMPLETE final unified diff relative to the SAME original base_head ${base.head}, not an incremental patch against the source proposal.`
    : "The workspace is a newly created Git repository with no commits yet (unborn repository state); the refined proposal must still only add ordinary text files using new file mode 100644, and must remain relative to the same unborn base.";
  const scope = base.kind === "unborn"
    ? "There are no tracked files to modify, so the proposed change must only add ordinary text files using new file mode 100644."
    : "Modify existing tracked regular text files, or add ordinary text files using new file mode 100644.";
  return `You are refining a proposed change for human review. The workspace is read-only.
Return only a unified textual Git diff for the requested change, beginning with "diff --git". Do not use Markdown fences or commentary. Do not include binary patches, deletions, renames or copies, mode changes, symlinks, or submodules. ${scope}

Treat the source proposal below as the reviewed baseline. Fix only the requested issues and preserve all unrelated proposal semantics. ${baseClause} Do not redo the original task.

Complete source proposal diff:
${sourceDiff}

Refinement request:
${changeRequest}`;
};

export class ControlledPatchService {
  private readonly proposals = new Map<Id, Proposal>();
  private appliedProposalTaskIds: Id[] = [];
  private persistenceQueue: Promise<void> = Promise.resolve();
  private writeSequence = 0;

  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly tasks: RegisteredWorkspaceTaskService,
    private readonly startProcess: GitStarter = spawn,
    private readonly stateFilePath?: string
  ) {}

  async load(): Promise<void> {
    if (this.stateFilePath === undefined) return;
    if (this.proposals.size !== 0) throw new CoreError("INTERNAL_ERROR");
    let source: string;
    try {
      source = await readFile(this.stateFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CoreError("INTERNAL_ERROR");
    }

    let retainedState: RetainedState;
    try {
      retainedState = parseRetainedState(JSON.parse(source));
      for (const proposal of retainedState.proposals) {
        if (this.registry.resolve(proposal.workspaceId) !== proposal.workspaceRoot) {
          throw new CoreError("INTERNAL_ERROR");
        }
      }
    } catch {
      throw new CoreError("INTERNAL_ERROR");
    }

    for (const { taskId, output, ...proposal } of retainedState.proposals) {
      const restoredState = proposal.state === "applying" ? "proposed" : proposal.state;
      this.proposals.set(taskId, { ...proposal, state: restoredState, output });
      this.tasks.restoreControlledPatchTask(taskId, output, restoredState !== "applied");
    }
    this.appliedProposalTaskIds = retainedState.appliedTaskIds;
  }

  async generate(request: { workspace_id: string; change_request: string }): Promise<{ taskId: Id; baseHead: string | null }> {
    // Generating a proposal is read-only analysis: any registered workspace
    // may propose; only APPLY requires controlled-write authorization.
    const workspaceRoot = this.registry.resolve(request.workspace_id);
    const base = await this.verifyWorkspace(workspaceRoot);
    return this.startProposal(request.workspace_id, workspaceRoot, base,
      PATCH_INSTRUCTION(request.change_request, base));
  }

  async refine(request: { patch_task_id: string; change_request: string }): Promise<{ taskId: Id; baseHead: string | null }> {
    const proposal = this.proposals.get(request.patch_task_id as Id);
    const sourceResult = this.tasks.result(request.patch_task_id);
    if (proposal === undefined || sourceResult === undefined || sourceResult.state !== "completed") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }

    const currentBase = await this.verifyWorkspace(proposal.workspaceRoot);
    if (!sameBase(currentBase, proposal.base)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return this.startProposal(proposal.workspaceId, proposal.workspaceRoot, proposal.base,
      REFINEMENT_INSTRUCTION(proposal.base, sourceResult.output, request.change_request),
      request.patch_task_id as Id);
  }

  async apply(request: { patch_task_id: string; confirmation: string }): Promise<{
    patch_task_id: Id;
    applied: true;
    changed_paths: string[];
  }> {
    if (request.confirmation !== "APPLY") throw new CoreError("INVALID_STATE_TRANSITION");
    const proposal = this.proposals.get(request.patch_task_id as Id);
    if (proposal === undefined || proposal.state !== "proposed") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }
    // APPLY is the single controlled-write authorization checkpoint: the
    // workspace must currently hold controlled-write permission.
    if (this.registry.resolveWritable(proposal.workspaceId) !== proposal.workspaceRoot) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    const result = this.tasks.result(request.patch_task_id);
    if (result === undefined || result.state !== "completed") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }

    proposal.state = "applying";
    try {
      await this.persist();
      const currentBase = await this.verifyWorkspace(proposal.workspaceRoot);
      // Unborn proposals require the repository to still be unborn: if the user
      // created the first commit meanwhile, this proposal must be rejected.
      if (!sameBase(currentBase, proposal.base)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      const targets = parsePatch(result.output);
      for (const target of targets) {
        if (proposal.base.kind === "unborn") {
          // No tracked files exist in an unborn repository, so only pure
          // additions are verifiable; modified targets cannot be checked.
          if (target.kind !== "added") failPatch();
        } else {
          const entry = await this.git(proposal.workspaceRoot, ["ls-tree", proposal.base.head, "--", target.path]);
          if (target.kind === "modified") {
            if (!/^(100644|100755) blob [0-9a-f]+\t[^\n]+\n?$/u.test(entry)) failPatch();
            continue;
          }
          if (entry.length !== 0) failPatch();
        }
        const indexEntry = await this.git(proposal.workspaceRoot, ["ls-files", "--stage", "--", target.path]);
        if (indexEntry.length !== 0 || await pathExists(resolve(proposal.workspaceRoot, target.path))) failPatch();
      }
      await this.git(proposal.workspaceRoot, ["apply", "--check", "--recount", "--unidiff-zero"], result.output);
      await this.git(proposal.workspaceRoot, ["apply", "--recount", "--unidiff-zero"], result.output);
      proposal.state = "applied";
      this.appliedProposalTaskIds.push(request.patch_task_id as Id);
      this.trimAppliedProposals();
      this.tasks.unpinTask(request.patch_task_id as Id);
      await this.persist();
      return { patch_task_id: request.patch_task_id as Id, applied: true, changed_paths: targets.map(({ path }) => path) };
    } catch (error) {
      if (proposal.state === "applying") {
        proposal.state = "proposed";
        await this.persist();
      }
      throw error;
    }
  }

  private startProposal(
    workspaceId: string,
    workspaceRoot: string,
    base: ProposalBase,
    instruction: string,
    parentTaskId?: Id
  ): { taskId: Id; baseHead: string | null } {
    const { taskId } = this.tasks.runTask({
      workspace_id: workspaceId,
      instruction
    }, normalizeTrailingLf, async (result) => {
      const proposal = this.proposals.get(result.id);
      if (result.state === "failed") {
        this.proposals.delete(result.id);
        this.tasks.unpinTask(result.id);
        return;
      }
      if (proposal === undefined) throw new CoreError("INTERNAL_ERROR");
      proposal.output = result.output;
      try {
        await this.persist();
      } catch (error) {
        this.proposals.delete(result.id);
        this.tasks.unpinTask(result.id);
        throw error;
      }
    });
    this.proposals.set(taskId, {
      workspaceId,
      workspaceRoot,
      base,
      state: "proposed",
      parentTaskId,
      output: undefined
    });
    this.tasks.pinTask(taskId);
    return { taskId, baseHead: base.kind === "commit" ? base.head : null };
  }

  private trimAppliedProposals(): void {
    const appliedTaskIds = this.appliedProposalTaskIds.filter(
      (taskId) => this.proposals.get(taskId)?.state === "applied"
    );
    const evictedTaskIds = appliedTaskIds.slice(
      0,
      Math.max(0, appliedTaskIds.length - MAX_APPLIED_PROPOSAL_HISTORY)
    );
    for (const taskId of evictedTaskIds) this.proposals.delete(taskId);
    this.appliedProposalTaskIds = appliedTaskIds.slice(-MAX_APPLIED_PROPOSAL_HISTORY);
  }

  private persist(): Promise<void> {
    if (this.stateFilePath === undefined) return Promise.resolve();
    const proposals: unknown[] = [];
    for (const [taskId, proposal] of this.proposals) {
      if (proposal.output === undefined) continue;
      proposals.push({
        task_id: taskId,
        workspace_id: proposal.workspaceId,
        workspace_root: proposal.workspaceRoot,
        base_head: proposal.base.kind === "commit" ? proposal.base.head : null,
        ...(proposal.base.kind === "unborn" ? { unborn: true } : {}),
        state: proposal.state,
        ...(proposal.parentTaskId === undefined ? {} : { parent_task_id: proposal.parentTaskId }),
        output: proposal.output
      });
    }
    const contents = `${JSON.stringify({
      version: CONTROLLED_PATCH_STATE_VERSION,
      applied_task_ids: this.appliedProposalTaskIds,
      proposals
    }, null, 2)}\n`;
    const write = this.persistenceQueue.then(() => this.replaceStateFile(contents));
    this.persistenceQueue = write.catch((): void => {});
    return write;
  }

  private async replaceStateFile(contents: string): Promise<void> {
    const stateFilePath = this.stateFilePath!;
    const temporaryPath = `${stateFilePath}.${process.pid}.${Date.now()}.${this.writeSequence++}.tmp`;
    try {
      await writeFile(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, stateFilePath);
    } catch {
      await unlink(temporaryPath).catch((): void => {});
      throw new CoreError("INTERNAL_ERROR");
    }
  }

  private async verifyWorkspace(workspaceRoot: string): Promise<ProposalBase> {
    const topLevel = (await this.git(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim();
    let canonicalTopLevel: string;
    let canonicalWorkspaceRoot: string;
    try {
      [canonicalTopLevel, canonicalWorkspaceRoot] = await Promise.all([
        realpath(resolve(topLevel)),
        realpath(resolve(workspaceRoot))
      ]);
    } catch {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }
    if (canonicalTopLevel !== canonicalWorkspaceRoot) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const status = await this.git(workspaceRoot, ["status", "--porcelain", "--untracked-files=no"]);
    if (status.length !== 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return this.detectBase(workspaceRoot);
  }

  // Distinguishes the three possible HEAD states without ever inferring "unborn"
  // from a bare nonzero exit or a catch-all failure. A repository is genuinely
  // unborn only when all of the following hold (stable, machine-decidable Git
  // primitives):
  //   1. `git rev-parse --verify --quiet HEAD` exits non-zero: HEAD does not
  //      resolve to a commit.
  //   2. `git symbolic-ref --quiet HEAD` exits zero and names a refs/heads/<branch>
  //      ref: HEAD is a symbolic branch ref, not detached, malformed, or absent.
  //   3. `git rev-parse --verify --quiet refs/heads/<branch>` exits non-zero:
  //      that branch has no commit yet (unborn branch state).
  // Any other combination — spawn/IO failures, detached or non-branch HEAD, or a
  // branch that resolves while HEAD does not — fails closed as
  // WORKSPACE_PRECONDITION_FAILED instead of being guessed as unborn.
  private async detectBase(workspaceRoot: string): Promise<ProposalBase> {
    const head = await this.gitResult(workspaceRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.code === 0) {
      const value = head.stdout.trim();
      if (!/^[0-9a-f]{40,64}$/u.test(value)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      return { kind: "commit", head: value };
    }
    const symbolicRef = await this.gitResult(workspaceRoot, ["symbolic-ref", "--quiet", "HEAD"]);
    if (symbolicRef.code !== 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const branch = symbolicRef.stdout.trim();
    if (!/^refs\/heads\/[^\s]+$/u.test(branch)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    const branchHead = await this.gitResult(workspaceRoot, ["rev-parse", "--verify", "--quiet", branch]);
    if (branchHead.code === 0) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return { kind: "unborn" };
  }

  private git(cwd: string, args: readonly string[], input?: string): Promise<string> {
    return new Promise((resolveOutput, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.startProcess("git", args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        reject(new CoreError("WORKSPACE_PRECONDITION_FAILED"));
        return;
      }
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.resume();
      child.on("error", () => reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
      child.on("close", (code) => code === 0
        ? resolveOutput(stdout)
        : reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
      child.stdin.on("error", () => reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
      child.stdin.end(input);
    });
  }

  // Exit-code-observing sibling of git(), used only for HEAD detection: it
  // resolves with the exit code and stdout instead of rejecting on nonzero, so
  // detectBase can prove the unborn state instead of assuming it. All other
  // calls keep using git(), which rejects on any nonzero exit.
  private gitResult(cwd: string, args: readonly string[], input?: string): Promise<GitExit> {
    return new Promise((resolveOutput, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.startProcess("git", args, { cwd, shell: false, stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        reject(new CoreError("WORKSPACE_PRECONDITION_FAILED"));
        return;
      }
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.resume();
      child.on("error", () => reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
      child.on("close", (code) => resolveOutput({ code: code ?? -1, stdout }));
      child.stdin.on("error", () => reject(new CoreError("WORKSPACE_PRECONDITION_FAILED")));
      child.stdin.end(input);
    });
  }
}

function parseRetainedState(value: unknown): RetainedState {
  if (!isObject(value) || value.version !== CONTROLLED_PATCH_STATE_VERSION ||
      !Array.isArray(value.applied_task_ids) || !Array.isArray(value.proposals)) {
    throw new CoreError("INTERNAL_ERROR");
  }

  const retained = value.proposals.map((item): RetainedProposal => {
    if (!isObject(item) || !isId(item.task_id) ||
        typeof item.workspace_id !== "string" || item.workspace_id.length === 0 ||
        typeof item.workspace_root !== "string" ||
        (item.unborn !== undefined && typeof item.unborn !== "boolean") ||
        !["proposed", "applying", "applied"].includes(item.state as string) ||
        (item.parent_task_id !== undefined && !isId(item.parent_task_id)) ||
        typeof item.output !== "string") {
      throw new CoreError("INTERNAL_ERROR");
    }
    return {
      taskId: item.task_id,
      workspaceId: item.workspace_id,
      workspaceRoot: item.workspace_root,
      base: parseProposalBase(item),
      state: item.state as Proposal["state"],
      parentTaskId: item.parent_task_id as Id | undefined,
      output: item.output
    };
  });

  const byTaskId = new Map<Id, RetainedProposal>();
  for (const proposal of retained) {
    if (byTaskId.has(proposal.taskId) || proposal.parentTaskId === proposal.taskId) {
      throw new CoreError("INTERNAL_ERROR");
    }
    byTaskId.set(proposal.taskId, proposal);
  }
  for (const proposal of retained) {
    if (proposal.parentTaskId === undefined) continue;
    const parent = byTaskId.get(proposal.parentTaskId);
    if (parent !== undefined && (parent.workspaceId !== proposal.workspaceId ||
        parent.workspaceRoot !== proposal.workspaceRoot ||
        !sameBase(proposal.base, parent.base))) {
      throw new CoreError("INTERNAL_ERROR");
    }
  }
  if (!value.applied_task_ids.every(isId)) throw new CoreError("INTERNAL_ERROR");
  const appliedTaskIds = value.applied_task_ids as Id[];
  const appliedTaskIdSet = new Set(appliedTaskIds);
  const appliedProposals = retained.filter(({ state }) => state === "applied");
  if (appliedTaskIds.length > MAX_APPLIED_PROPOSAL_HISTORY ||
      appliedTaskIdSet.size !== appliedTaskIds.length ||
      appliedProposals.length !== appliedTaskIds.length ||
      appliedProposals.some(({ taskId }) => !appliedTaskIdSet.has(taskId))) {
    throw new CoreError("INTERNAL_ERROR");
  }
  return { proposals: retained, appliedTaskIds };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeTrailingLf(output: string): string {
  return `${output.replace(/\n*$/u, "")}\n`;
}

type PatchTarget = { path: string; kind: "modified" | "added" };

function parsePatch(patch: string): PatchTarget[] {
  if (!patch.startsWith("diff --git ") || patch.includes("GIT binary patch") ||
      patch.includes("Binary files ") || /^(old mode|new mode|deleted file mode|similarity index|rename (from|to)|copy (from|to)) /mu.test(patch)) {
    throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }
  const lines = patch.split("\n");
  const targets: PatchTarget[] = [];
  let index = 0;
  while (index < lines.length && lines[index] !== "") {
    const header = lines[index];
    if (header === undefined || !header.startsWith("diff --git ")) failPatch();
    const match = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(header);
    if (match === null || match[1] !== match[2] || !safePath(match[1]!)) failPatch();
    const path = match[1]!;
    index += 1;
    const start = index;
    while (index < lines.length && !lines[index]!.startsWith("diff --git ")) index += 1;
    const section = lines.slice(start, index).join("\n");
    const newFileModes = section.match(/^new file mode .*$/gmu) ?? [];
    const oldHeaders = section.match(/^--- .*$/gmu) ?? [];
    const newHeaders = section.match(/^\+\+\+ .*$/gmu) ?? [];
    const addition = newFileModes.length > 0;
    if (addition) {
      if (newFileModes.length !== 1 || newFileModes[0] !== "new file mode 100644" ||
          !section.startsWith("new file mode 100644\n") ||
          oldHeaders.length !== 1 || oldHeaders[0] !== "--- /dev/null" ||
          newHeaders.length !== 1 || newHeaders[0] !== `+++ b/${path}` ||
          !section.includes(`--- /dev/null\n+++ b/${path}\n`)) failPatch();
    } else if (oldHeaders.length !== 1 || oldHeaders[0] !== `--- a/${path}` ||
               newHeaders.length !== 1 || newHeaders[0] !== `+++ b/${path}` ||
               !section.includes(`--- a/${path}\n+++ b/${path}\n`)) {
      failPatch();
    }
    if (!/^@@ /mu.test(section)) failPatch();
    targets.push({ path, kind: addition ? "added" : "modified" });
  }
  if (targets.length === 0 || new Set(targets.map(({ path }) => path)).size !== targets.length) failPatch();
  return targets;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    failPatch();
  }
}

function safePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes("\\") &&
    !path.split("/").includes("..") && posix.normalize(path) === path && path !== "/dev/null";
}

function failPatch(): never {
  throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
}

// Strictly parses the persisted base-state fields. A proposal base is either a
// real commit (base_head = <hex>, unborn absent/false) or the unborn repository
// state (base_head = null, unborn = true); every other combination is invalid
// retained state and is rejected like the existing invalid-record handling.
function parseProposalBase(item: Record<string, unknown>): ProposalBase {
  if (item.unborn === true) {
    if (item.base_head !== null) throw new CoreError("INTERNAL_ERROR");
    return { kind: "unborn" };
  }
  if (typeof item.base_head !== "string" || !/^[0-9a-f]{40,64}$/u.test(item.base_head)) {
    throw new CoreError("INTERNAL_ERROR");
  }
  return { kind: "commit", head: item.base_head };
}

function sameBase(current: ProposalBase, expected: ProposalBase): boolean {
  if (current.kind === "unborn") return expected.kind === "unborn";
  return expected.kind === "commit" && current.head === expected.head;
}
