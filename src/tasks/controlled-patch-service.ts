import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";

import { CoreError } from "../core/errors.js";
import type { Id } from "../core/ids.js";
import { RegisteredWorkspaceRegistry } from "../workspaces/registered-workspace-registry.js";
import { RegisteredWorkspaceTaskService } from "./registered-workspace-task-service.js";

export type GitStarter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

type Proposal = {
  workspaceId: string;
  workspaceRoot: string;
  baseHead: string;
  state: "proposed" | "applying" | "applied";
};

const MAX_APPLIED_PROPOSAL_HISTORY = 100;

const PATCH_INSTRUCTION = (changeRequest: string): string => `You are preparing a proposed change for human review. The workspace is read-only.
Return only a unified textual Git diff for the requested change, beginning with "diff --git". Do not use Markdown fences or commentary. Do not include binary patches, deletions, renames or copies, mode changes, symlinks, or submodules. Modify existing tracked regular text files, or add ordinary text files using new file mode 100644.

Change request:
${changeRequest}`;

export class ControlledPatchService {
  private readonly proposals = new Map<Id, Proposal>();
  private appliedProposalTaskIds: Id[] = [];

  constructor(
    private readonly registry: RegisteredWorkspaceRegistry,
    private readonly tasks: RegisteredWorkspaceTaskService,
    private readonly startProcess: GitStarter = spawn
  ) {}

  async generate(request: { workspace_id: string; change_request: string }): Promise<{ taskId: Id; baseHead: string }> {
    const workspaceRoot = this.registry.resolveWritable(request.workspace_id);
    const baseHead = await this.verifyWorkspace(workspaceRoot);
    const { taskId } = this.tasks.runTask({
      workspace_id: request.workspace_id,
      instruction: PATCH_INSTRUCTION(request.change_request)
    }, normalizeTrailingLf, (result) => {
      if (result.state === "failed") {
        this.proposals.delete(result.id);
        this.tasks.unpinTask(result.id);
      }
    });
    this.proposals.set(taskId, {
      workspaceId: request.workspace_id,
      workspaceRoot,
      baseHead,
      state: "proposed"
    });
    this.tasks.pinTask(taskId);
    return { taskId, baseHead };
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
    const result = this.tasks.result(request.patch_task_id);
    if (result === undefined || result.state !== "completed") {
      throw new CoreError("INVALID_STATE_TRANSITION");
    }

    proposal.state = "applying";
    try {
      const currentHead = await this.verifyWorkspace(proposal.workspaceRoot);
      if (currentHead !== proposal.baseHead) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
      const targets = parsePatch(result.output);
      for (const target of targets) {
        const entry = await this.git(proposal.workspaceRoot, ["ls-tree", proposal.baseHead, "--", target.path]);
        if (target.kind === "modified") {
          if (!/^(100644|100755) blob [0-9a-f]+\t[^\n]+\n?$/u.test(entry)) failPatch();
          continue;
        }
        if (entry.length !== 0) failPatch();
        const indexEntry = await this.git(proposal.workspaceRoot, ["ls-files", "--stage", "--", target.path]);
        if (indexEntry.length !== 0 || await pathExists(resolve(proposal.workspaceRoot, target.path))) failPatch();
      }
      await this.git(proposal.workspaceRoot, ["apply", "--check", "--recount", "--unidiff-zero"], result.output);
      await this.git(proposal.workspaceRoot, ["apply", "--recount", "--unidiff-zero"], result.output);
      proposal.state = "applied";
      this.appliedProposalTaskIds.push(request.patch_task_id as Id);
      this.trimAppliedProposals();
      this.tasks.unpinTask(request.patch_task_id as Id);
      return { patch_task_id: request.patch_task_id as Id, applied: true, changed_paths: targets.map(({ path }) => path) };
    } catch (error) {
      proposal.state = "proposed";
      throw error;
    }
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

  private async verifyWorkspace(workspaceRoot: string): Promise<string> {
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
    const head = (await this.git(workspaceRoot, ["rev-parse", "HEAD"])).trim();
    if (!/^[0-9a-f]{40,64}$/u.test(head)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return head;
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
