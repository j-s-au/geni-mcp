#!/usr/bin/env node
// Entry point: stdio MCP server for Claude Code / Claude Desktop.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TokenStore } from "./auth/token-store.js";
import { loadConfig } from "./config.js";
import { GeniClient } from "./http/geni-client.js";
import { AuditLog } from "./safety/audit-log.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new GeniClient(config, new TokenStore(config.tokenFile));
  const server = createServer({ client, config, audit: new AuditLog(config.auditLogFile) });
  await server.connect(new StdioServerTransport());
  console.error(`geni-mcp running on stdio (write level: ${config.writeLevel})`);
}

main().catch((err) => {
  console.error("geni-mcp failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
