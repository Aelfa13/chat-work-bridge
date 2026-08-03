import { isAbsolute, normalize } from "node:path";

import { CoreError } from "../core/errors.js";

export interface WorkspaceRegistration {
  readonly id: string;
  readonly root: string;
}

export class RegisteredWorkspaceRegistry {
  private readonly roots = new Map<string, string>();

  constructor(entries: readonly WorkspaceRegistration[]) {
    for (const entry of entries) {
      if (typeof entry.id !== "string" || entry.id.length === 0 ||
          typeof entry.root !== "string" || entry.root.length === 0 ||
          !isAbsolute(entry.root) || normalize(entry.root) !== entry.root ||
          this.roots.has(entry.id)) {
        throw new CoreError("WORKSPACE_BOUNDARY_VIOLATION");
      }
      this.roots.set(entry.id, entry.root);
    }
  }

  resolve(workspaceId: string): string {
    const root = this.roots.get(workspaceId);
    if (root === undefined) throw new CoreError("UNKNOWN_WORKSPACE");
    return root;
  }
}
