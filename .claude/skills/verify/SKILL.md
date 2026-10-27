---
name: verify
description: Verify geni-mcp changes at runtime by driving the built server over stdio against a local fake Geni API.
---

# Verifying geni-mcp

The surface is the MCP server over stdio (`node dist/index.js`), exactly as Claude Code launches it.
Never point verification at the real Geni API: `GENI_API_BASE` and `GENI_OAUTH_BASE` redirect it to a fake.

## Run

```bash
npm run build
node .claude/skills/verify/harness.mjs "$PWD/dist/index.js" /abs/path/to/scenario.mjs
```

The harness starts a fake Geni on `127.0.0.1:<random>`, writes a fake token, spawns the server with
an isolated temp `HOME`, sends `initialize`, runs the scenario, then prints every request the fake
received and the server's stderr. Every stdout line is parsed as JSON-RPC, so stray output fails loudly.

A scenario is an ES module whose default export gets `{ call, hits, uploads, base, ms }`:

```js
export default async function ({ call }) {
  const r = await call("geni_raw_get", { path: "profile-1/documents" });
  console.log(r.isError, r.text);
}
```

Env knobs: `LEVEL` (write level, default `full`), `INTERVAL` (min ms between requests), `LOGGED_IN=0`
(no token, for auth flows), `REDIRECT` (OAuth redirect URI; default `http://127.0.0.1:38999/cb`).
Add fake routes in `harness.mjs` for the endpoints a scenario touches; unknown routes return 404.

## Flows worth driving

- Write guard: `LEVEL=readonly` and call a write tool; the fake must receive nothing.
- `geni_raw_get` refusals: encoded, `;`, control-character and write-segment paths.
- Partial batches (`tag_media`, `add_to_project`): make one fake route return 403.
- Rate limiting: a route answering 429 with `Retry-After` while a second call is queued; compare hit times.
- OAuth: `LOGGED_IN=0`, `auth_start`, then `fetch` the callback URL with and without the state.
- Before/after: `git worktree add <tmp> HEAD`, symlink `node_modules`, `npx tsc -p tsconfig.build.json`, run the same scenario.

## Gotchas

- Keep the token file and audit log out of the upload folder's parents: uploads from inside the token's
  folder are refused by design. The harness puts them in `<tmp>/config/`.
- `GENI_MIN_INTERVAL_MS` has a 250 ms floor, so requests are always at least 250 ms apart.
