import { mkdtempSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TokenStore } from "../src/auth/token-store.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { encodeForm } from "../src/http/form.js";
import { RateLimiter, type Clock } from "../src/http/rate-limiter.js";
import { InvalidIdError, normalizeId, profileId, refToId } from "../src/ids.js";
import { AuditLog } from "../src/safety/audit-log.js";
import { assertConfirmed, assertWriteAllowed, WriteBlockedError } from "../src/safety/write-guard.js";
import { buildAhnentafel, generationOf } from "../src/tree/ahnentafel.js";
import { FamilyGraph } from "../src/tree/graph.js";
import { dropEmpty, formatDate, formatEvent, summarizeProfile } from "../src/tree/summarize.js";
import { appendNote } from "../src/tools/profiles-write.js";
import { ancestorsResponse } from "./fixtures/ancestors.js";

describe("ids", () => {
  it.each([
    ["profile-123", "profile-123"],
    ["123", "profile-123"],
    ["6999999999999999999", "profile-g6999999999999999999"],
    ["g6999999999999999999", "profile-g6999999999999999999"],
    ["https://www.geni.com/people/Jan-Example/6999999999999999999", "profile-g6999999999999999999"],
    ["https://www.geni.com/api/profile-42/immediate-family", "profile-42"],
    [" Profile-7 ", "profile-7"],
  ])("normalizes %s", (input, expected) => {
    expect(profileId(input)).toBe(expected);
  });

  it("handles other types and rejects mismatches", () => {
    expect(normalizeId("union", "12276689")).toBe("union-12276689");
    expect(normalizeId("photo_album", "photo_album-3")).toBe("photo_album-3");
    expect(() => normalizeId("union", "profile-1")).toThrow(InvalidIdError);
    expect(() => profileId("")).toThrow(InvalidIdError);
    expect(() => profileId("abc def")).toThrow(InvalidIdError);
    expect(() => profileId("https://example.com/nothing")).toThrow(InvalidIdError);
    expect(normalizeId("document", "https://www.geni.com/documents/view/document-5")).toBe("document-5");
  });

  it("turns API URLs into ids", () => {
    expect(refToId("https://www.geni.com/api/union-5")).toBe("union-5");
    expect(refToId("weird")).toBe("weird");
  });
});

describe("config", () => {
  it("requires credentials and validates values", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    const base = { GENI_CLIENT_ID: "a", GENI_CLIENT_SECRET: "b" };
    const c = loadConfig(base);
    expect(c.writeLevel).toBe("safe");
    expect(c.minIntervalMs).toBe(2000);
    expect(loadConfig({ ...base, GENI_WRITE_LEVEL: "FULL", GENI_MIN_INTERVAL_MS: "500" })).toMatchObject({
      writeLevel: "full",
      minIntervalMs: 500,
    });
    expect(() => loadConfig({ ...base, GENI_WRITE_LEVEL: "yolo" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, GENI_MAX_RETRIES: "-1" })).toThrow(ConfigError);
  });
});

describe("form encoding", () => {
  it("uses Rails bracket keys", () => {
    const body = encodeForm({
      first_name: "Jan",
      birth: { date: { year: 1900, circa: true }, location: { city: "Paarl" } },
      tags: ["a", "b"],
      skip: undefined,
      none: null,
    });
    expect(decodeURIComponent(body)).toBe(
      "first_name=Jan&birth[date][year]=1900&birth[date][circa]=true&birth[location][city]=Paarl&tags[0]=a&tags[1]=b",
    );
  });
});

describe("rate limiter", () => {
  function fakeClock() {
    let t = 0;
    const slept: number[] = [];
    const clock: Clock = { now: () => t, sleep: async (ms) => void (slept.push(ms), (t += ms)) };
    return { clock, slept, advance: (ms: number) => (t += ms) };
  }

  it("spaces calls by the minimum interval", async () => {
    const { clock, slept } = fakeClock();
    const limiter = new RateLimiter(2000, clock);
    await Promise.all([1, 2, 3].map((n) => limiter.schedule(async () => n)));
    expect(slept).toEqual([2000, 2000]);
  });

  it("waits for the window when Geni says none remain", async () => {
    const { clock, slept } = fakeClock();
    const limiter = new RateLimiter(0, clock);
    limiter.observe(new Headers({ "X-API-Rate-Limit": "40", "X-API-Rate-Remaining": "0", "X-API-Rate-Window": "10" }));
    expect(limiter.snapshot()).toMatchObject({ limit: 40, remaining: 0, windowSeconds: 10 });
    await limiter.schedule(async () => undefined);
    expect(slept).toEqual([10_000]);
  });

  it("sees the previous call's rate headers before starting the next, even when it answers slowly", async () => {
    const { clock, slept } = fakeClock();
    const limiter = new RateLimiter(2000, clock);
    let answer!: () => void;
    const first = limiter.schedule(
      () =>
        new Promise<void>((resolve) => {
          answer = () => {
            limiter.observe(new Headers({ "X-API-Rate-Limit": "1", "X-API-Rate-Remaining": "0", "X-API-Rate-Window": "10" }));
            resolve();
          };
        }),
    );
    let secondStarted = false;
    const second = limiter.schedule(async () => void (secondStarted = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(secondStarted).toBe(false);
    answer();
    await Promise.all([first, second]);
    expect(slept).toEqual([10_000]);
  });

  it("ignores responses without rate headers and keeps going after a failure", async () => {
    const { clock } = fakeClock();
    const limiter = new RateLimiter(0, clock);
    limiter.observe(new Headers());
    expect(limiter.snapshot()).toEqual({});
    await expect(limiter.schedule(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(limiter.schedule(async () => 5)).resolves.toBe(5);
  });

  it("re-checks a pause that starts while a call is already waiting", async () => {
    let t = 0;
    const slept: number[] = [];
    const wakes: Array<() => void> = [];
    const clock: Clock = {
      now: () => t,
      sleep: (ms) => new Promise<void>((resolve) => void (slept.push(ms), wakes.push(() => ((t += ms), resolve())))),
    };
    const limiter = new RateLimiter(2000, clock);
    const started: number[] = [];
    await limiter.schedule(async () => void started.push(t));
    const second = limiter.schedule(async () => void started.push(t));
    await vi.waitFor(() => expect(slept).toEqual([2000]));
    limiter.pause(5000);
    wakes.shift()!();
    await vi.waitFor(() => expect(slept).toEqual([2000, 3000]));
    wakes.shift()!();
    await second;
    expect(started).toEqual([0, 5000]);
  });
});

describe("token store", () => {
  it("saves privately, reloads, and clears", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tok-")), "sub", "tokens.json");
    const store = new TokenStore(file);
    expect(await store.load()).toBeNull();
    await store.save({ accessToken: "a", refreshToken: "r", expiresAt: 123 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await new TokenStore(file).load()).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 123 });
    await store.clear();
    expect(await new TokenStore(file).load()).toBeNull();
  });

  it("treats a malformed file as logged out and checks expiry with a margin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tok-"));
    const file = join(dir, "t.json");
    await import("node:fs/promises").then((fs) => fs.writeFile(file, '{"accessToken": 5}'));
    expect(await new TokenStore(file).load()).toBeNull();
    expect(TokenStore.isExpired({ accessToken: "a" })).toBe(false);
    expect(TokenStore.isExpired({ accessToken: "a", expiresAt: 100_000 }, 50_000)).toBe(true);
    expect(TokenStore.isExpired({ accessToken: "a", expiresAt: 200_000 }, 50_000)).toBe(false);
  });
});

describe("write guard", () => {
  it("enforces levels and confirmation", () => {
    expect(() => assertWriteAllowed("safe", "safe", "t")).not.toThrow();
    expect(() => assertWriteAllowed("full", "full", "t")).not.toThrow();
    expect(() => assertWriteAllowed("safe", "full", "t")).toThrow(/GENI_WRITE_LEVEL=full/);
    expect(() => assertWriteAllowed("readonly", "safe", "t")).toThrow(/read-only/);
    expect(() => assertConfirmed(undefined, "t", "do it")).toThrow(WriteBlockedError);
    expect(() => assertConfirmed(true, "t", "do it")).not.toThrow();
  });
});

describe("audit log", () => {
  it("appends JSON lines", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "audit-")), "a", "audit.jsonl");
    const log = new AuditLog(file, () => new Date("2026-10-27T00:00:00Z"));
    await log.record({ tool: "x", target: "profile-1", request: { a: 1 }, outcome: "ok" });
    await log.record({ tool: "y", target: "profile-2", request: {}, outcome: "error", error: "bad" });
    const lines = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ at: "2026-10-27T00:00:00.000Z", tool: "x" });
  });

  it("does not throw when the log cannot be written", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    await import("node:fs/promises").then((fs) => fs.writeFile(join(dir, "file"), ""));
    const log = new AuditLog(join(dir, "file", "audit.jsonl"));
    await expect(log.record({ tool: "x", target: "t", request: {}, outcome: "ok" })).resolves.toBeUndefined();
  });
});

describe("summaries", () => {
  it("formats dates, places and events", () => {
    expect(formatDate({ year: 1850, month: 3, day: 2 })).toBe("1850-03-02");
    expect(formatDate({ year: 1850, circa: true })).toBe("c. 1850");
    expect(formatDate({ year: 1850, range: "before" })).toBe("before 1850");
    expect(formatDate({ year: 1850, range: "after" })).toBe("after 1850");
    expect(formatDate({ year: 1850, range: "between", end_year: 1855, end_circa: true })).toBe("between 1850 and c. 1855");
    expect(formatDate(undefined)).toBe("");
    expect(formatEvent({ date: { year: 1900 }, location: { place_name: "Paarl" } })).toBe("1900, Paarl");
    expect(formatEvent({ location: { city: "Paarl", country: "South Africa" } })).toBe("Paarl, South Africa");
    expect(formatEvent({})).toBeUndefined();
    expect(formatEvent("x")).toBeUndefined();
  });

  it("summarizes profiles and drops empties", () => {
    expect(summarizeProfile({ id: "profile-1", first_name: "Jan", last_name: "Botha", is_alive: false })).toEqual({
      id: "profile-1",
      name: "Jan Botha",
      is_alive: false,
    });
    expect(dropEmpty({ a: [], b: "", c: null, d: { e: undefined }, f: [1] })).toEqual({ d: {}, f: [1] });
  });
});

describe("family graph and Ahnentafel", () => {
  it("reads relationships from edges", () => {
    const g = new FamilyGraph(ancestorsResponse);
    expect(g.focusId).toBe("profile-1");
    expect(g.parents("profile-1").sort()).toEqual(["profile-2", "profile-3"]);
    expect(g.children("profile-2")).toEqual(["profile-1"]);
    expect(g.partners("profile-2")).toEqual(["profile-3"]);
    expect(g.siblings("profile-1")).toEqual([]);
  });

  it("numbers ancestors and lists gaps", () => {
    const { rows, missing } = buildAhnentafel(new FamilyGraph(ancestorsResponse), 3);
    expect(rows.map((r) => [r.ahnentafel, r.name])).toEqual([
      [1, "Jan Botha"],
      [2, "Piet Botha"],
      [3, "Anna de Villiers"],
      [4, "Hans Botha"],
      [5, "Maria Roux"],
    ]);
    expect(rows[1]!.birth).toBe("c. 1920, Paarl, South Africa");
    expect(missing).toEqual([6, 7]);
    expect(generationOf(1)).toBe(1);
    expect(generationOf(7)).toBe(3);
  });

  it("flags unknown genders, multiple parent couples and pedigree collapse", () => {
    const g = new FamilyGraph({
      focus: { id: "profile-1" },
      nodes: {
        "union-a": { edges: { "profile-2": { rel: "partner" }, "profile-3": { rel: "partner" }, "profile-1": { rel: "child" } } },
        "union-b": { edges: { "profile-9": { rel: "partner" }, "profile-1": { rel: "child" } } },
        "union-c": { edges: { "profile-4": { rel: "partner" }, "profile-2": { rel: "child" }, "profile-3": { rel: "child" } } },
        "profile-2": { id: "profile-2" },
        "profile-3": { id: "profile-3", gender: "female" },
      },
    });
    const { rows } = buildAhnentafel(g, 3);
    expect(rows[0]!.note).toMatch(/2 parent couples/);
    expect(rows.find((r) => r.ahnentafel === 1)!.note).toMatch(/gender/);
    const fours = rows.filter((r) => r.id === "profile-4");
    expect(fours).toHaveLength(2);
    expect(fours[1]!.note).toMatch(/pedigree collapse/);
    expect(buildAhnentafel(new FamilyGraph({}), 3)).toEqual({ rows: [], missing: [] });
  });
});

describe("appendNote", () => {
  it("keeps existing text and adds a dated block", () => {
    expect(appendNote("Old text.\n", "New fact.", "2026-10-27")).toBe("Old text.\n\nResearch note (2026-10-27):\nNew fact.");
    expect(appendNote(undefined, " x ", "2026-01-01", "Correction")).toBe("Correction (2026-01-01):\nx");
  });
});

describe("refToId anchoring", () => {
  it("does not pick an id out of the middle of a segment", () => {
    expect(refToId("union-profile-1")).toBe("union-profile-1");
    expect(refToId("profile-1")).toBe("profile-1");
  });
});
