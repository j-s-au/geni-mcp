import { describe, expect, it } from "vitest";
import { buildAuthorizationUrl, exchangeCode, extractCode, OAuthError, refreshTokens, tokenCheck } from "../src/auth/oauth.js";
import { waitForCallback } from "../src/auth/callback-server.js";
import { TokenStore } from "../src/auth/token-store.js";
import { classify, GeniApiError, GeniClient, NotAuthenticatedError } from "../src/http/geni-client.js";
import { fakeFetch, instantClock, json, testConfig } from "./helpers.js";

async function clientWith(routes: Parameters<typeof fakeFetch>[0], tokens = { accessToken: "tok", refreshToken: "ref" }) {
  const config = testConfig({ maxRetries: 2 });
  const store = new TokenStore(config.tokenFile);
  if (tokens) await store.save(tokens);
  const f = fakeFetch(routes);
  return { client: new GeniClient(config, store, f.fn, instantClock), calls: f.calls, store, config };
}

describe("GeniClient", () => {
  it("sends the bearer token, query and form body", async () => {
    const { client, calls } = await clientWith([() => json({ ok: true })]);
    await client.get("/api/profile-1", { fields: "id,name", skip: undefined });
    await client.post("profile-1/update", { birth: { date: { year: 1900 } } });
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok");
    expect(calls[0]!.url.toString()).toBe("https://www.geni.com/api/profile-1?fields=id%2Cname");
    expect(calls[1]!.method).toBe("POST");
    expect(decodeURIComponent(String(calls[1]!.body))).toBe("birth[date][year]=1900");
  });

  it("rejects paths that leave the API", async () => {
    const { client } = await clientWith([]);
    expect(() => client.buildUrl("https://evil.example/x")).toThrow(/Invalid API path/);
    expect(() => client.buildUrl("profile-1/../../x")).toThrow(/Invalid API path/);
    expect(() => client.buildUrl("profile-1/%2e%2e/%2e%2e/platform")).toThrow(/Invalid API path/);
    expect(() => client.buildUrl("//evil.example/x")).not.toThrow();
    expect(client.buildUrl("//evil.example/x")).toBe("https://www.geni.com/api/evil.example/x");
  });

  it("retries when rate-limited, then succeeds", async () => {
    let n = 0;
    const { client } = await clientWith([
      () => (++n === 1 ? json({ error: "Rate limit exceeded" }, 403, { "X-API-Rate-Window": "10" }) : json({ ok: n })),
    ]);
    instantClock.slept.length = 0;
    await expect(client.get("user")).resolves.toEqual({ ok: 2 });
    expect(instantClock.slept).toContain(10_000);
  });

  it("holds the next queued call until the window Geni reports has passed", async () => {
    let n = 0;
    const { client } = await clientWith([
      () => json({ ok: ++n }, 200, { "X-API-Rate-Limit": "1", "X-API-Rate-Remaining": "0", "X-API-Rate-Window": "10" }),
    ]);
    instantClock.slept.length = 0;
    await Promise.all([client.get("user"), client.get("user")]);
    expect(instantClock.slept.some((ms) => ms >= 9_000)).toBe(true);
  });

  it("gives up after maxRetries rate-limit responses", async () => {
    const { client } = await clientWith([() => new Response("slow down", { status: 429, headers: { "Retry-After": "1" } })]);
    await expect(client.get("user")).rejects.toMatchObject({ kind: "rate_limit", status: 429 });
  });

  it("refreshes the token once after a 401", async () => {
    let n = 0;
    const { client, store, calls } = await clientWith([
      (c) => (c.url.pathname.endsWith("request_token") ? json({ access_token: "new", expires_in: 86400 }) : undefined),
      () => (++n === 1 ? json({ error: { type: "OAuthException", message: "invalid_token" } }, 401) : json({ ok: true })),
    ]);
    await expect(client.get("user")).resolves.toEqual({ ok: true });
    expect((await store.load())?.accessToken).toBe("new");
    expect((await store.load())?.refreshToken).toBe("ref");
    expect(calls.at(-1)!.headers.Authorization).toBe("Bearer new");
  });

  it("refreshes an expired token before calling", async () => {
    const { client, calls } = await clientWith(
      [
        (c) => (c.url.pathname.endsWith("request_token") ? json({ access_token: "new2", refresh_token: "r2" }) : undefined),
        () => json({ ok: true }),
      ],
      { accessToken: "old", refreshToken: "ref", expiresAt: 1 } as never,
    );
    await client.get("user");
    expect(calls[0]!.url.searchParams.get("grant_type")).toBe("refresh_token");
    expect(calls[1]!.headers.Authorization).toBe("Bearer new2");
  });

  it("explains when not logged in", async () => {
    const { client } = await clientWith([], null as never);
    await expect(client.get("user")).rejects.toThrow(NotAuthenticatedError);
    const expired = await clientWith([], { accessToken: "a", expiresAt: 1 } as never);
    await expect(expired.client.get("user")).rejects.toThrow(NotAuthenticatedError);
  });

  it("stops at an IP block without retrying", async () => {
    let n = 0;
    const { client } = await clientWith([
      () => (n++, new Response("<html><h1>Access Denied</h1>IP temporarily blocked</html>", { status: 403 })),
    ]);
    await expect(client.get("user")).rejects.toMatchObject({ kind: "blocked" });
    expect(n).toBe(1);
  });

  it("after a block page, refuses further calls without contacting Geni", async () => {
    let n = 0;
    const { client } = await clientWith([() => (n++, new Response("<html>IP temporarily blocked</html>", { status: 403 }))]);
    await expect(client.get("user")).rejects.toMatchObject({ kind: "blocked" });
    await expect(client.get("user")).rejects.toThrow(/Not calling Geni again/);
    expect(n).toBe(1);
  });

  it("reuses a token another request already refreshed", async () => {
    const { client, store, calls } = await clientWith([
      (c) => (c.headers.Authorization === "Bearer tok" ? json({ error: "invalid_token" }, 401) : json({ ok: true })),
    ]);
    const first = client.get("user");
    await store.save({ accessToken: "already-new", refreshToken: "r2" });
    await expect(first).resolves.toEqual({ ok: true });
    expect(calls.some((c) => c.url.pathname.endsWith("request_token"))).toBe(false);
  });

  it("reports non-JSON success bodies and empty bodies", async () => {
    const { client } = await clientWith([
      (c) => (c.url.pathname.endsWith("empty") ? new Response("", { status: 200 }) : new Response("<html>", { status: 200 })),
    ]);
    await expect(client.get("empty")).resolves.toEqual({});
    await expect(client.get("x")).rejects.toThrow(GeniApiError);
  });
});

describe("classify", () => {
  it("reads the different error shapes", () => {
    expect(classify(404, JSON.stringify({ error: { message: "Not found" } }))).toMatchObject({ kind: "not_found" });
    expect(classify(400, JSON.stringify({ error: "bad", message: "field x" })).message).toContain("bad: field x");
    expect(classify(500, "plain text")).toMatchObject({ kind: "api" });
    expect(classify(403, JSON.stringify({ error: "Access denied for this profile" }))).toMatchObject({ kind: "api" });
  });
});

describe("oauth", () => {
  const config = testConfig();

  it("builds the documented authorize URL", () => {
    const url = new URL(buildAuthorizationUrl(config, "s1"));
    expect(url.origin + url.pathname).toBe("https://www.geni.com/platform/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: "app", response_type: "code", state: "s1" });
  });

  it("exchanges and refreshes codes", async () => {
    const f = fakeFetch([() => json({ access_token: "a", refresh_token: "r", expires_in: 100 })]);
    expect(await exchangeCode(config, "c", f.fn, 1000)).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 101_000 });
    expect(f.calls[0]!.url.pathname).toBe("/platform/oauth/request_token");
    expect(f.calls[0]!.url.searchParams.get("code")).toBe("c");
    await refreshTokens(config, "r", f.fn);
    expect(f.calls[1]!.url.searchParams.get("refresh_token")).toBe("r");
  });

  it("surfaces token errors", async () => {
    const bad = fakeFetch([() => json({ error: "invalid_request", error_description: "redirect mismatch" }, 400)]);
    await expect(exchangeCode(config, "c", bad.fn)).rejects.toThrow(/redirect mismatch/);
    const html = fakeFetch([() => new Response("<html>", { status: 500 })]);
    await expect(exchangeCode(config, "c", html.fn)).rejects.toThrow(OAuthError);
  });

  it("validates tokens", async () => {
    const ok = fakeFetch([() => json({ result: "OK" })]);
    expect(await tokenCheck(config, "validate_token", "t", ok.fn)).toEqual({ result: "OK" });
    const text = fakeFetch([() => new Response("nope", { status: 401 })]);
    expect(await tokenCheck(config, "invalidate_token", "t", text.fn)).toEqual({ status: 401, body: "nope" });
  });

  it("sends the token as the access_token query parameter, not a Bearer header", async () => {
    const ok = fakeFetch([() => json({ result: "OK" })]);
    await tokenCheck(config, "validate_token", "t0k", ok.fn);
    const sent = ok.calls[0]!;
    expect(sent.url.pathname).toBe("/platform/oauth/validate_token");
    expect(sent.url.searchParams.get("access_token")).toBe("t0k");
    expect(sent.headers.Authorization).toBeUndefined();
  });

  it("extracts codes from pasted input", () => {
    expect(extractCode(" abc ")).toEqual({ code: "abc" });
    expect(extractCode("http://localhost:3000/oauth/callback?code=xyz&state=s")).toEqual({ code: "xyz", state: "s" });
    expect(() => extractCode("http://localhost:3000/cb?status=unauthorized&message=user+canceled")).toThrow(/user canceled/);
    expect(() => extractCode("http://localhost:3000/cb")).toThrow(/No code/);
  });
});

describe("callback server", () => {
  it("captures the redirect and answers with a page", async () => {
    const listener = waitForCallback("http://127.0.0.1:38911/oauth/callback", 5000);
    await listener.ready;
    expect((await fetch("http://127.0.0.1:38911/other")).status).toBe(404);
    const res = await fetch("http://127.0.0.1:38911/oauth/callback?code=abc&state=s");
    expect(await res.text()).toContain("login received");
    await expect(listener.result).resolves.toEqual({ code: "abc", state: "s", error: undefined });
  });

  it("reports a denied login and refuses https redirect URIs", async () => {
    const listener = waitForCallback("http://127.0.0.1:38912/cb", 5000);
    await listener.ready;
    await fetch("http://127.0.0.1:38912/cb?status=unauthorized&message=user+canceled");
    expect((await listener.result).error).toBe("user canceled");
    expect(() => waitForCallback("https://example.com/cb", 1000)).toThrow(/http:\/\//);
  });

  it("listens on loopback for a made-up redirect hostname", async () => {
    const listener = waitForCallback("http://geni-mcp.test:38915/oauth/callback", 5000);
    await listener.ready;
    await fetch("http://127.0.0.1:38915/oauth/callback?code=abc");
    await expect(listener.result).resolves.toMatchObject({ code: "abc" });
  });

  it("ignores a denial or code that does not carry the login's state", async () => {
    const listener = waitForCallback("http://127.0.0.1:38914/cb", 5000, "good");
    await listener.ready;
    expect((await fetch("http://127.0.0.1:38914/cb?message=user+canceled")).status).toBe(400);
    expect((await fetch("http://127.0.0.1:38914/cb?message=x&state=bad")).status).toBe(400);
    expect((await fetch("http://127.0.0.1:38914/cb?code=abc&state=bad")).status).toBe(400);
    await fetch("http://127.0.0.1:38914/cb?message=user+canceled&state=good");
    expect((await listener.result).error).toBe("user canceled");
  });

  it("times out", async () => {
    const listener = waitForCallback("http://127.0.0.1:38913/cb", 50);
    await listener.ready;
    expect((await listener.result).error).toMatch(/timed out/);
  });
});
