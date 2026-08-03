import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";

import { CoreError } from "../core/errors.js";

declare const trustedWorkspaceBrand: unique symbol;

export interface TrustedWorkspace {
  readonly id: string;
  readonly canonicalRoot: string;
  readonly [trustedWorkspaceBrand]: true;
}

const issuedWorkspaces = new WeakSet<object>();

export function trustedWorkspaceRoot(workspace: TrustedWorkspace): string {
  if (typeof workspace !== "object" || workspace === null || !issuedWorkspaces.has(workspace)) {
    throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
  }
  return workspace.canonicalRoot;
}

export interface WorkspaceRegistration {
  readonly id: string;
  readonly root: string;
  readonly allowedBranches: readonly string[];
  readonly requireClean: boolean;
}

export type GitProcessStarter = (
  executable: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export type GitRunner = (root: string, args: readonly string[]) => Promise<string>;

export interface GitRunnerOptions {
  readonly startProcess?: GitProcessStarter;
  readonly hostEnvironment?: Readonly<NodeJS.ProcessEnv>;
  readonly timeoutMs?: number;
  readonly stdoutLimitBytes?: number;
}

export const GIT_ARGUMENT_PREFIX = [
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false"
] as const;
export const GIT_TIMEOUT_MS = 10_000;
export const GIT_STDOUT_LIMIT_BYTES = 1024 * 1024;

function gitEnvironment(host: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "LANG", "LC_ALL"] as const) {
    const value = host[name];
    if (value !== undefined && value.length > 0) environment[name] = value;
  }
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

export function createGitRunner(options: GitRunnerOptions = {}): GitRunner {
  const startProcess = options.startProcess ?? spawn;
  const hostEnvironment = options.hostEnvironment ?? process.env;
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const stdoutLimitBytes = options.stdoutLimitBytes ?? GIT_STDOUT_LIMIT_BYTES;

  return (root, args) => new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = startProcess("git", [...GIT_ARGUMENT_PREFIX, ...args], {
        cwd: root,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: gitEnvironment(hostEnvironment)
      });
    } catch {
      reject(new CoreError("WORKSPACE_PRECONDITION_FAILED"));
      return;
    }

    let output = "";
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error === undefined) resolve(output);
      else reject(new CoreError("WORKSPACE_PRECONDITION_FAILED"));
    };
    const terminate = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process termination details are deliberately discarded.
      }
    };
    const timer = setTimeout(() => {
      terminate();
      finish(false);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > stdoutLimitBytes) {
        terminate();
        finish(false);
        return;
      }
      output += chunk;
    });
    child.stdout.on("error", finish);
    child.stderr.on("error", finish);
    child.stderr.resume();
    child.stdin.on("error", finish);
    child.stdin.end();
    child.on("error", finish);
    child.on("close", (code) => finish(code === 0 ? undefined : false));
  });
}

interface FileProbes {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>;
  realpath(path: string): Promise<string>;
}

const nodeFileProbes: FileProbes = { lstat, realpath };

export class RegisteredWorkspaceRegistry {
  private readonly registrations = new Map<string, WorkspaceRegistration>();

  constructor(
    registrations: readonly WorkspaceRegistration[],
    private readonly runGit: GitRunner = createGitRunner(),
    private readonly files: FileProbes = nodeFileProbes
  ) {
    for (const registration of registrations) {
      if (registration.id.length === 0 || this.registrations.has(registration.id) ||
          registration.allowedBranches.length === 0 ||
          registration.allowedBranches.some((branch) => branch.length === 0)) {
        throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
      }
      this.registrations.set(registration.id, Object.freeze({
        ...registration,
        allowedBranches: Object.freeze([...registration.allowedBranches])
      }));
    }
  }

  async resolve(workspaceId: string): Promise<TrustedWorkspace> {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    if (!isAbsolute(registration.root)) throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");

    let canonicalRoot: string;
    try {
      const stat = await this.files.lstat(registration.root);
      if (stat.isSymbolicLink()) throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
      canonicalRoot = await this.files.realpath(registration.root);
      if (canonicalRoot !== normalize(registration.root)) {
        throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
      }
    } catch {
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }

    let topLevel: string;
    let inside: string;
    let branch: string;
    let status = "";
    try {
      topLevel = (await this.runGit(canonicalRoot, ["rev-parse", "--show-toplevel"])).trimEnd();
      inside = (await this.runGit(canonicalRoot, ["rev-parse", "--is-inside-work-tree"])).trim();
      branch = (await this.runGit(canonicalRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trimEnd();
      if (registration.requireClean) {
        status = await this.runGit(canonicalRoot, [
          "status", "--porcelain=v1", "--untracked-files=all", "--no-renames"
        ]);
      }
    } catch {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }

    let canonicalTopLevel: string;
    try {
      canonicalTopLevel = await this.files.realpath(topLevel);
    } catch {
      throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    }
    if (canonicalTopLevel !== canonicalRoot) throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
    if (inside !== "true" || branch.length === 0 || !registration.allowedBranches.includes(branch) || status.length !== 0) {
      throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    }

    const workspace = Object.freeze({ id: registration.id, canonicalRoot }) as unknown as TrustedWorkspace;
    issuedWorkspaces.add(workspace);
    return workspace;
  }
}
