import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
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

const PATCH_INSTRUCTION = (changeRequest: string): string => `You are preparing a proposed change for human review. The workspace is read-only.
Return only a unified textual Git diff for the requested change, beginning with "diff --git". Do not use Markdown fences or commentary. Do not include binary patches, file additions or deletions, renames or copies, mode changes, or symlink changes. Modify existing tracked text files only.

Change request:
${changeRequest}`;

export class ControlledPatchService {
  private readonly proposals = new Map<Id, Proposal>();

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
    });
    this.proposals.set(taskId, {
      workspaceId: request.workspace_id,
      workspaceRoot,
      baseHead,
      state: "proposed"
    });
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
      const changedPaths = parsePatch(result.output);
      for (const path of changedPaths) {
        const entry = await this.git(proposal.workspaceRoot, ["ls-tree", proposal.baseHead, "--", path]);
        if (!/^(100644|100755) blob [0-9a-f]+\t[^\n]+\n?$/u.test(entry)) {
          throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
        }
      }
      await this.git(proposal.workspaceRoot, ["apply", "--check"], result.output);
      await this.git(proposal.workspaceRoot, ["apply"], result.output);
      proposal.state = "applied";
      return { patch_task_id: request.patch_task_id as Id, applied: true, changed_paths: changedPaths };
    } catch (error) {
      proposal.state = "proposed";
      throw error;
    }
  }

  private async verifyWorkspace(workspaceRoot: string): Promise<string> {
    const topLevel = (await this.git(workspaceRoot, ["rev-parse", "--show-toplevel"])).trim();
    if (resolve(topLevel) !== resolve(workspaceRoot)) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
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

function parsePatch(patch: string): string[] {
  if (!patch.startsWith("diff --git ") || patch.includes("```") || patch.includes("GIT binary patch") ||
      patch.includes("Binary files ") || /^(old mode|new mode|new file mode|deleted file mode|similarity index|rename (from|to)|copy (from|to)) /mu.test(patch)) {
    throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
  }
  const lines = patch.split("\n");
  const paths: string[] = [];
  let index = 0;
  while (index < lines.length && lines[index] !== undefined) {
    const header = lines[index];
    if (header === undefined || !header.startsWith("diff --git ")) {
      index += 1;
      continue;
    }
    const match = /^diff --git a\/(\S+) b\/(\S+)$/u.exec(header);
    if (match === null || match[1] !== match[2] || !safePath(match[1]!)) failPatch();
    const path = match[1]!;
    paths.push(path);
    index += 1;
    while (index < lines.length && !lines[index]!.startsWith("diff --git ")) index += 1;
  }
  if (paths.length === 0 || new Set(paths).size !== paths.length) failPatch();
  for (const path of paths) {
    if (!patch.includes(`--- a/${path}\n+++ b/${path}\n`) || !patch.includes("@@ ")) failPatch();
  }
  return paths;
}

function safePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes("\\") &&
    !path.split("/").includes("..") && posix.normalize(path) === path && path !== "/dev/null";
}

function failPatch(): never {
  throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
}
