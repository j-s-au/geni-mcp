// Drives the built geni-mcp server over stdio against a local fake Geni API that logs every request.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SERVER = process.argv[2];
const t0 = Date.now();
const ms = () => Date.now() - t0;
const hits = [];
let rateLimitedOnce = false;

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const fake = createServer((req, res) => {
  hits.push({ at: ms(), method: req.method, raw: req.url });
  const r = `${req.method} ${new URL(req.url, "http://x").pathname}`;
  if (r === "GET /api/profile-1") return json(res, 200, { id: "profile-1", first_name: "Jn", about_me: "Old." });
  if (r === "GET /api/profile-1/documents") return json(res, 200, { results: [] });
  if (r === "GET /api/profile-7") {
    if (!rateLimitedOnce) {
      rateLimitedOnce = true;
      return json(res, 429, { error: { message: "Rate limit exceeded" } }, { "Retry-After": "3" });
    }
    return json(res, 200, { id: "profile-7", name: "A" });
  }
  if (r === "GET /api/profile-8") return json(res, 200, { id: "profile-8", name: "B" });
  if (r === "POST /api/document-1/tag/profile-1") return json(res, 200, { result: "tagged" });
  if (r === "POST /api/document-1/tag/profile-2") return json(res, 403, { error: { message: "Access denied" } });
  if (r === "POST /api/project-6/add_profiles") return json(res, 200, { result: "ok" });
  if (r === "POST /api/project-6/add_documents") return json(res, 403, { error: { message: "Not a collaborator" } });
  if (r === "POST /api/document/add") return json(res, 200, { id: "document-1" });
  if (r === "POST /api/profile-1/add-mugshot") return json(res, 200, { id: "photo-2" });
  if (r === "POST /api/photo/add") return json(res, 200, { id: "photo-1" });
  if (r === "POST /api/union-5/add-child") return json(res, 200, { id: "profile-99" });
  if (r === "GET /oauth/request_token") return json(res, 200, { access_token: "fresh", refresh_token: "r", expires_in: 86400 });
  json(res, 404, { error: { message: `no fake route for ${r}` } });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${fake.address().port}`;

const dir = mkdtempSync(join(tmpdir(), "geni-verify-"));
const uploads = join(dir, "uploads");
mkdirSync(uploads);
writeFileSync(join(uploads, "grave.jpg"), Buffer.from("fakejpegbytes"));
mkdirSync(join(dir, "config"));
const tokenFile = join(dir, "config", "tokens.json");
if (process.env.LOGGED_IN !== "0") {
  writeFileSync(tokenFile, JSON.stringify({ accessToken: "FAKE", expiresAt: Date.now() + 3_600_000 }), { mode: 0o600 });
}

const child = spawn("node", [SERVER], {
  env: {
    PATH: process.env.PATH,
    HOME: dir,
    GENI_CLIENT_ID: "app",
    GENI_CLIENT_SECRET: "secret",
    GENI_REDIRECT_URI: process.env.REDIRECT ?? "http://127.0.0.1:38999/cb",
    GENI_API_BASE: `${base}/api`,
    GENI_OAUTH_BASE: `${base}/oauth`,
    GENI_WRITE_LEVEL: process.env.LEVEL ?? "full",
    GENI_MIN_INTERVAL_MS: process.env.INTERVAL ?? "0",
    GENI_TOKEN_FILE: tokenFile,
    GENI_AUDIT_LOG: join(dir, "config", "audit.jsonl"),
    GENI_UPLOAD_DIRS: uploads,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const msg = JSON.parse(line); // throws if stdout carries anything but JSON-RPC
    pending.get(msg.id)?.(msg);
  }
});
let nextId = 1;
const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const call = async (name, args) => {
  const started = ms();
  const msg = await send("tools/call", { name, arguments: args });
  const r = msg.result ?? {};
  return { name, args, started, done: ms(), isError: Boolean(r.isError), text: r.content?.[0]?.text ?? JSON.stringify(msg.error) };
};

await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "0" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const scenario = (await import(process.argv[3])).default;
await scenario({ call, hits, uploads, base, ms });
console.log("--- fake Geni received:");
for (const h of hits) console.log(`  t=${h.at}ms ${h.method} ${JSON.stringify(h.raw)}`);
console.log("--- server stderr:", JSON.stringify(stderr.trim()));
child.kill();
fake.close();
