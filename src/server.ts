// Builds the MCP server and registers every tool with the shared guard and error handling.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { assertWriteAllowed } from "./safety/write-guard.js";
import { dropEmpty } from "./tree/summarize.js";
import { authTools } from "./tools/auth.js";
import { collectionTools } from "./tools/collections.js";
import { mediaTools } from "./tools/media.js";
import { profileReadTools } from "./tools/profiles-read.js";
import { profileWriteTools } from "./tools/profiles-write.js";
import type { ToolContext, ToolDef } from "./tools/shared.js";
import { unionTools } from "./tools/unions.js";

export const SERVER_NAME = "geni";
export const SERVER_VERSION = "0.1.0";

export const ALL_TOOLS: readonly ToolDef[] = [
  ...authTools,
  ...profileReadTools,
  ...profileWriteTools,
  ...unionTools,
  ...mediaTools,
  ...collectionTools,
];

const INSTRUCTIONS = `Geni.com genealogy API (the shared World Family Tree).
- Start with auth_status; if not logged in, run auth_start and give the user the URL.
- Requests are deliberately slow (one every ~2 s). Prefer get_ancestors (20 generations in one call) and get_profiles (50 at once) over many single lookups.
- Geni is a shared tree: before any write, show the user the change (dry_run where available) and get approval. Structural changes (add_relative, add_to_union, create_profile, merge, delete) also need confirm: true and GENI_WRITE_LEVEL=full.
- Profile ids can be given as profile-123, a Geni ID like 6999999999999999999, or a geni.com URL.`;

export function toResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(dropEmpty(value), null, 2) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  for (const def of ALL_TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.write ? `${def.description} [write: ${def.write}]` : def.description,
        inputSchema: def.input,
        annotations: {
          readOnlyHint: !def.write,
          destructiveHint: Boolean(def.destructive),
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>, extra: { signal?: AbortSignal }) => {
        try {
          if (def.write) assertWriteAllowed(ctx.config.writeLevel, def.write, def.name);
          return toResult(await def.handler(args as never, { ...ctx, signal: extra.signal }));
        } catch (err) {
          return errorResult(err);
        }
      },
    );
  }
  return server;
}
