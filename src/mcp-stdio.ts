#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { CodexExecutor } from "./executors/codex-executor.js";
import { RegisteredWorkspaceTaskService } from "./tasks/registered-workspace-task-service.js";
import { RegisteredWorkspaceRegistry } from "./workspaces/registered-workspace-registry.js";

const WorkspaceConfigSchema = z.array(z.object({
  id: z.string().min(1),
  root: z.string().min(1)
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
  const server = new McpServer({ name: "engineering-bridge", version: "0.1.0-alpha.0" });

  server.registerTool("run_task", {
    inputSchema: {
      workspace_id: z.string().min(1),
      instruction: z.string().min(1)
    }
  }, ({ workspace_id, instruction }) => {
    const { taskId } = service.runTask({ workspace_id, instruction });
    return jsonContent({ task_id: taskId });
  });

  server.registerTool("task_status", {
    inputSchema: { task_id: z.string() }
  }, ({ task_id }) => {
    const status = service.status(task_id);
    return status === undefined
      ? unknownTask()
      : jsonContent({ task_id: status.taskId, state: status.state });
  });

  server.registerTool("task_result", {
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

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Failed to start engineering-bridge.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
