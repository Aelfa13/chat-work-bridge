#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CodexExecutor } from "./executors/codex-executor.js";
import { RegisteredWorkspaceTaskService } from "./tasks/registered-workspace-task-service.js";
import { ControlledPatchService } from "./tasks/controlled-patch-service.js";
import { RegisteredWorkspaceRegistry } from "./workspaces/registered-workspace-registry.js";

const WorkspaceConfigSchema = z.array(z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  allow_write: z.boolean().optional()
}).strict());

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

function unknownTask() {
  return {
    isError: true,
    ...jsonContent({ error: "UNKNOWN_TASK" })
  };
}

async function main(): Promise<void> {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node dist/src/mcp-stdio.js /absolute/path/to/workspaces.json");
  }

  const configPath = process.argv[2];
  if (configPath === undefined) throw new Error("Workspace configuration path is required.");
  const entries = WorkspaceConfigSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
  const registry = new RegisteredWorkspaceRegistry(entries);
  const service = new RegisteredWorkspaceTaskService(
    registry,
    (workspaceRoot) => new CodexExecutor(workspaceRoot)
  );
  const controlledPatches = new ControlledPatchService(registry, service);
  const server = new McpServer({ name: "engineering-bridge", version: "0.2.0-alpha.3" });

  server.registerTool("run_task", {
    description: "Run a read-only Codex task in a pre-registered workspace. This tool does not modify workspace files.",
    inputSchema: {
      workspace_id: z.string().min(1),
      instruction: z.string().min(1)
    }
  }, ({ workspace_id, instruction }) => {
    const { taskId } = service.runTask({ workspace_id, instruction });
    return jsonContent({ task_id: taskId });
  });

  server.registerTool("task_result", {
    description: "Retrieve the completed output or safe error for a task. This tool is read-only.",
    inputSchema: { task_id: z.string() }
  }, ({ task_id }) => {
    const status = service.status(task_id);
    if (status === undefined) return unknownTask();
    if (status.state === "queued" || status.state === "running") {
      return jsonContent({ task_id: status.taskId, state: status.state, ready: false });
    }

    const result = service.result(task_id);
    if (result === undefined) return unknownTask();
    return result.state === "completed"
      ? jsonContent({ task_id: result.id, state: result.state, output: result.output })
      : jsonContent({ task_id: result.id, state: result.state, error: result.error });
  });

  server.registerTool("generate_controlled_patch", {
    description: "Generate a read-only patch proposal for review in a write-enabled Git workspace; it does not apply changes.",
    inputSchema: {
      workspace_id: z.string().min(1),
      change_request: z.string().min(1)
    }
  }, async ({ workspace_id, change_request }) => {
    const proposal = await controlledPatches.generate({ workspace_id, change_request });
    return jsonContent({ task_id: proposal.taskId, base_head: proposal.baseHead });
  });

  server.registerTool("apply_controlled_patch", {
    description: "Apply one reviewed patch proposal after exact APPLY confirmation. This tool can modify validated tracked text files or add absent 100644 text files, but never stages, commits, or pushes.",
    inputSchema: {
      patch_task_id: z.string().min(1),
      confirmation: z.literal("APPLY")
    }
  }, async ({ patch_task_id, confirmation }) => jsonContent(
    await controlledPatches.apply({ patch_task_id, confirmation })
  ));

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Failed to start engineering-bridge.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
