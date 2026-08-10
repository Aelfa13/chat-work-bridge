import { isAbsolute, normalize } from "node:path";

import { CoreError } from "../core/errors.js";

export interface WorkspaceRegistration {
  readonly id: string;
  readonly root: string;
  readonly allow_write?: boolean | undefined;
}

export class RegisteredWorkspaceRegistry {
  private readonly registrations = new Map<string, { root: string; allowWrite: boolean }>();

  constructor(entries: readonly WorkspaceRegistration[]) {
    for (const entry of entries) {
      if (typeof entry.id !== "string" || entry.id.length === 0 ||
          typeof entry.root !== "string" || entry.root.length === 0 ||
          (entry.allow_write !== undefined && typeof entry.allow_write !== "boolean") ||
          !isAbsolute(entry.root) || normalize(entry.root) !== entry.root ||
          this.registrations.has(entry.id)) {
        throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
      }
      this.registrations.set(entry.id, { root: entry.root, allowWrite: entry.allow_write ?? false });
    }
  }

  resolve(workspaceId: string): string {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    return registration.root;
  }

  resolveExecution(workspaceId: string): { root: string; allowWrite: boolean } {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    return { ...registration };
  }

  resolveWritable(workspaceId: string): string {
    const registration = this.registrations.get(workspaceId);
    if (registration === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    if (!registration.allowWrite) throw new CoreError("WORKSPACE_PRECONDITION_FAILED");
    return registration.root;
  }
}
