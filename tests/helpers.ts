import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TokenStore } from "../src/auth/token-store.js";
import { loadConfig, type Config, type WriteLevel } from "../src/config.js";
import { GeniClient } from "../src/http/geni-client.js";
import type { Clock } from "../src/http/rate-limiter.js";
import { AuditLog } from "../src/safety/audit-log.js";
import { createServer } from "../src/server.js";

export interface Call {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | FormData | undefined;
}

export type Route = (call: Call) => Response | undefined;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** A fetch stand-in that records calls and answers from the first matching route. */
export function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | FormData | undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const res = route(call);
      if (res) return res;
    }
    return json({ error: { message: `no route for ${call.method} ${call.url.pathname}` } }, 404);
  }) as typeof fetch;
  return { fn, calls };
}

/** Matches `METHOD /api/path` (path without query). */
export function on(method: string, path: string, respond: (call: Call) => Response): Route {
  return (call) => (call.method === method && call.url.pathname === `/api/${path}` ? respond(call) : undefined);
}

export const instantClock: Clock & { slept: number[] } = Object.assign(
  { now: () => Date.now(), sleep: async (ms: number) => void instantClock.slept.push(ms) },
  { slept: [] as number[] },
);

export function testConfig(overrides: Partial<Config> = {}): Config {
  const root = mkdtempSync(join(tmpdir(), "geni-mcp-test-"));
  const dir = join(root, "config");
  const uploads = join(root, "uploads");
  mkdirSync(dir);
  mkdirSync(uploads);
  return {
    ...loadConfig({ GENI_CLIENT_ID: "app", GENI_CLIENT_SECRET: "secret", GENI_CONFIG_DIR: dir, GENI_UPLOAD_DIRS: uploads }),
    minIntervalMs: 0,
    ...overrides,
  };
}

export async function setup(routes: Route[], opts: { writeLevel?: WriteLevel; loggedIn?: boolean } = {}) {
  const config = testConfig({ writeLevel: opts.writeLevel ?? "safe" });
  const tokens = new TokenStore(config.tokenFile);
  if (opts.loggedIn !== false) await tokens.save({ accessToken: "tok", refreshToken: "ref", expiresAt: Date.now() + 3_600_000 });
  const fetcher = fakeFetch(routes);
  const client = new GeniClient(config, tokens, fetcher.fn, instantClock);
  const ctx = { client, config, audit: new AuditLog(config.auditLogFile) };
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), mcp.connect(b)]);

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    const text = res.content[0]!.text;
    return { isError: Boolean(res.isError), text, data: res.isError ? undefined : JSON.parse(text) };
  };
  const auditLines = () => {
    try {
      return readFileSync(config.auditLogFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  };
  return { mcp, call, calls: fetcher.calls, config, tokens, auditLines, uploadDir: config.uploadDirs[0]! };
}

/** Decodes a form-encoded request body into a plain map. */
export function formOf(call: Call): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(call.body ?? "")));
}
