import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const VERSION_MODULE = new URL("../../src/version.js", import.meta.url);

test("MCP and Codex client metadata use the shared package VERSION, and stdio returns structured tool errors", async () => {
  const { VERSION } = await import(VERSION_MODULE.href) as { VERSION: unknown };
  const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: unknown }).version;

  assert.equal(VERSION, packageVersion);
  for (const path of ["src/mcp-stdio.ts", "src/executors/codex-executor.ts"]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /import\s+\{\s*VERSION\s*\}\s+from\s+["'][^"']*version\.js["'];/u);
    assert.match(source, /version:\s*VERSION\b/u);
  }

  const configPath = join(mkdtempSync(join(tmpdir(), "engineering-bridge-mcp-")), "workspaces.json");
  writeFileSync(configPath, "[]\n");
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(process.cwd(), "dist/src/mcp-stdio.js"), configPath],
    cwd: process.cwd(),
    stderr: "pipe"
  });

  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, VERSION);

    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(({ name }) => name).sort(), [
      "apply_controlled_patch",
      "control_task",
      "generate_controlled_patch",
      "refine_controlled_patch",
      "run_task",
      "task_result"
    ]);

    const result = await client.callTool({
      name: "generate_controlled_patch",
      arguments: { workspace_id: "missing", change_request: "change nothing" }
    });
    assert.equal(result.isError, true);
    const resultContent = result.content;
    assert.ok(Array.isArray(resultContent));
    const content = resultContent[0] as { type?: string; text?: string } | undefined;
    assert.equal(content?.type, "text");
    if (content?.type !== "text" || typeof content.text !== "string") return;
    assert.deepEqual(JSON.parse(content.text), {
      error: {
        code: "UNKNOWN_WORKSPACE",
        message: "The requested workspace is not registered."
      }
    });

    const refinementResult = await client.callTool({
      name: "refine_controlled_patch",
      arguments: { patch_task_id: "missing", change_request: "refine nothing" }
    });
    assert.equal(refinementResult.isError, true);
    const refinementResultContent = refinementResult.content;
    assert.ok(Array.isArray(refinementResultContent));
    const refinementContent = refinementResultContent[0] as { type?: string; text?: string } | undefined;
    assert.equal(refinementContent?.type, "text");
    if (refinementContent?.type !== "text" || typeof refinementContent.text !== "string") return;
    assert.deepEqual(JSON.parse(refinementContent.text), {
      error: {
        code: "INVALID_STATE_TRANSITION",
        message: "The requested state transition is not allowed."
      }
    });
  } finally {
    await client.close();
  }
});
