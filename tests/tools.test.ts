import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_TOOLS } from "../src/server.js";
import { resetPendingLogin } from "../src/tools/auth.js";
import { ancestorsResponse, immediateFamily } from "./fixtures/ancestors.js";
import { formOf, json, on, setup } from "./helpers.js";

afterEach(() => {
  resetPendingLogin();
  vi.unstubAllGlobals();
});

describe("tool registry", () => {
  it("registers every tool once with annotations", async () => {
    const { mcp } = await setup([]);
    const { tools } = await mcp.listTools();
    expect(tools).toHaveLength(ALL_TOOLS.length);
    expect(new Set(tools.map((t) => t.name)).size).toBe(tools.length);
    const merge = tools.find((t) => t.name === "merge_profiles")!;
    expect(merge.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    expect(tools.find((t) => t.name === "get_ancestors")!.annotations?.readOnlyHint).toBe(true);
  });
});

describe("profile reads", () => {
  it("get_profile asks for default fields and ids", async () => {
    const { call, calls } = await setup([on("GET", "profile-g6999999999999999999", () => json({ id: "profile-1", name: "Jan" }))]);
    const res = await call("get_profile", { profile_id: "https://www.geni.com/people/Jan/6999999999999999999" });
    expect(res.data).toEqual({ id: "profile-1", name: "Jan" });
    expect(calls[0]!.url.searchParams.get("fields")).toContain("about_me");
    expect(calls[0]!.url.searchParams.get("only_ids")).toBe("true");
  });

  it("get_profile without an id returns the user's own profile", async () => {
    const { call } = await setup([on("GET", "profile", () => json({ id: "profile-9" }))]);
    expect((await call("get_profile")).data).toEqual({ id: "profile-9" });
  });

  it("get_profiles batches and summarizes", async () => {
    const { call, calls } = await setup([
      on("GET", "profile", () => json({ results: [{ id: "profile-1", first_name: "A", birth: { date: { year: 1800 } } }] })),
    ]);
    const res = await call("get_profiles", { profile_ids: ["profile-1", "6000000000000000001"] });
    expect(calls[0]!.url.searchParams.get("ids")).toBe("1,g6000000000000000001");
    expect(res.data.results[0]).toEqual({ id: "profile-1", name: "A", birth: "1800" });
    const full = await call("get_profiles", { profile_ids: ["1"], full: true });
    expect(full.data.results[0].birth).toEqual({ date: { year: 1800 } });
  });

  it("get_ancestors returns Ahnentafel rows", async () => {
    const { call, calls } = await setup([on("GET", "profile-1/ancestors", () => json(ancestorsResponse))]);
    const res = await call("get_ancestors", { profile_id: "1", generations: 2 });
    expect(calls[0]!.url.searchParams.get("generations")).toBe("2");
    expect(res.data.ancestors.map((r: { ahnentafel: number }) => r.ahnentafel)).toEqual([1, 2, 3, 4, 5]);
    expect(res.data.missing).toEqual([6, 7]);
    const raw = await call("get_ancestors", { profile_id: "1", raw: true });
    expect(raw.data.focus.id).toBe("profile-1");
  });

  it("get_ancestors climbs immediate-family when Geni has not approved the app", async () => {
    const refused = json({ error: { type: "ApiException", message: "Approved client app required" } }, 403);
    const route = (c: { url: URL }) => {
      if (c.url.pathname.endsWith("/ancestors")) return refused.clone();
      const id = c.url.pathname.match(/(profile-\d+)\/immediate-family/)?.[1];
      return id ? json({ ...ancestorsResponse, focus: { id } }) : undefined;
    };
    const { call, calls } = await setup([route]);
    const res = await call("get_ancestors", { profile_id: "1", generations: 2 });
    expect(res.data.method).toMatch(/walked/);
    expect(res.data.ancestors.map((r: { ahnentafel: number }) => r.ahnentafel)).toEqual([1, 2, 3, 4, 5]);
    expect(res.data.missing).toEqual([6, 7]);
    expect(calls.map((c) => c.url.pathname.replace("/api/", ""))).toEqual([
      "profile-1/ancestors",
      "profile-1/immediate-family",
      "profile-2/immediate-family",
      "profile-3/immediate-family",
    ]);
    const capped = await call("get_ancestors", { profile_id: "1", generations: 10 });
    expect(capped.data).toMatchObject({ generations: 6, note: expect.stringMatching(/Capped/) });
  });

  it.each([
    ["a Geni ID", "6000000043193929304"],
    ["a profile URL", "https://www.geni.com/people/Jan-Botha/6000000043193929304"],
    ["a profile-g id", "profile-g6000000043193929304"],
  ])("get_ancestors walks on a 'Permission denied' 403 when given %s", async (_label, profile_id) => {
    const denied = json({ error: { type: "ApiException", message: "Permission denied" } }, 403);
    const route = (c: { url: URL }) => {
      if (c.url.pathname.endsWith("/ancestors")) return denied.clone();
      const id = c.url.pathname.match(/(profile-g?\d+)\/immediate-family/)?.[1];
      // Geni answers a GUID request with numeric ids.
      return id ? json({ ...ancestorsResponse, focus: { id: id.startsWith("profile-g") ? "profile-1" : id } }) : undefined;
    };
    const { call, calls } = await setup([route]);
    const res = await call("get_ancestors", { profile_id, generations: 2 });
    expect(res.isError).toBe(false);
    expect(res.data.method).toMatch(/walked.*Permission denied/);
    expect(res.data.ancestors.map((r: { ahnentafel: number }) => r.ahnentafel)).toEqual([1, 2, 3, 4, 5]);
    expect(calls.map((c) => c.url.pathname.replace("/api/", ""))).toEqual([
      "profile-g6000000043193929304/ancestors",
      "profile-g6000000043193929304/immediate-family",
      "profile-2/immediate-family",
      "profile-3/immediate-family",
    ]);
  });

  it("get_ancestors walk skips an unreadable ancestor but not an unreadable root", async () => {
    const denied = json({ error: { type: "ApiException", message: "Permission denied" } }, 403);
    const route = (c: { url: URL }) => {
      if (c.url.pathname.endsWith("/ancestors") || c.url.pathname.includes("profile-3/")) return denied.clone();
      const id = c.url.pathname.match(/(profile-\d+)\/immediate-family/)?.[1];
      return id ? json({ ...ancestorsResponse, focus: { id } }) : undefined;
    };
    const { call } = await setup([route]);
    const res = await call("get_ancestors", { profile_id: "1", generations: 2 });
    expect(res.data.unreadable).toEqual(["profile-3"]);
    expect(res.data.ancestors.map((r: { ahnentafel: number }) => r.ahnentafel)).toEqual([1, 2, 3, 4, 5]);

    const root = await call("get_ancestors", { profile_id: "3" });
    expect(root.isError).toBe(true);
    expect(root.text).toMatch(/Permission denied/);
  });

  it("get_ancestors does not walk on a rate-limit 403", async () => {
    const { call, calls } = await setup([
      on("GET", "profile-1/ancestors", () => json({ error: { type: "ApiException", message: "Rate limit exceeded." } }, 403)),
    ]);
    expect((await call("get_ancestors", { profile_id: "1" })).isError).toBe(true);
    expect(calls.every((c) => c.url.pathname.endsWith("/ancestors"))).toBe(true);
  });

  it("get_ancestors passes on other errors", async () => {
    const { call } = await setup([on("GET", "profile-1/ancestors", () => json({ error: "boom" }, 500))]);
    expect((await call("get_ancestors", { profile_id: "1" })).isError).toBe(true);
  });

  it("get_immediate_family lists relatives with unions", async () => {
    const { call } = await setup([on("GET", "profile-2/immediate-family", () => json(ancestorsResponse))]);
    const res = await call("get_immediate_family", { profile_id: "profile-2" });
    expect(res.data.parents.map((p: { id: string }) => p.id).sort()).toEqual(["profile-4", "profile-5"]);
    expect(res.data.partners).toEqual([{ union: "union-10", id: "profile-3", name: "Anna de Villiers", gender: "female" }]);
    expect(res.data.children[0]).toMatchObject({ union: "union-10", id: "profile-1" });
  });

  it("get_immediate_family follows Geni's numeric focus id when asked by GUID", async () => {
    const { call } = await setup([on("GET", "profile-g6000000000000000001/immediate-family", () => json(ancestorsResponse))]);
    const res = await call("get_immediate_family", { profile_id: "6000000000000000001" });
    expect(res.data.focus.id).toBe("profile-1");
    expect(res.data.parents.map((p: { id: string }) => p.id).sort()).toEqual(["profile-2", "profile-3"]);
  });

  it("get_descendants walks the tree and respects limits", async () => {
    const families: Record<string, string[]> = {
      "profile-1": ["profile-2", "profile-3"],
      "profile-2": ["profile-4"],
      "profile-3": [],
    };
    const route = (c: { url: URL }) => {
      const id = c.url.pathname.match(/(profile-\d+)\/immediate-family/)?.[1];
      return id ? json(immediateFamily(id, families[id] ?? [])) : undefined;
    };
    const { call, calls } = await setup([route]);
    const res = await call("get_descendants", { profile_id: "1", generations: 2 });
    expect(res.data.descendants.map((d: { id: string; generation: number }) => [d.id, d.generation])).toEqual([
      ["profile-1", 0],
      ["profile-2", 1],
      ["profile-3", 1],
      ["profile-4", 2],
    ]);
    expect(calls).toHaveLength(3);
    const limited = await call("get_descendants", { profile_id: "1", generations: 3, max_profiles: 1 });
    expect(limited.data.truncated).toBe(true);
  });

  it("get_relationship_path never notifies and polls while pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let n = 0;
    const { call, calls } = await setup([
      on("GET", "profile-1/path-to/profile-2", () => json(++n === 1 ? { status: "pending" } : { status: "done", relationship: "cousin" })),
    ]);
    const pending = call("get_relationship_path", { from_profile_id: "1", to_profile_id: "2", path_type: "blood" });
    await vi.advanceTimersByTimeAsync(6000);
    const res = await pending;
    vi.useRealTimers();
    expect(res.data.relationship).toBe("cousin");
    expect(calls[0]!.url.searchParams.get("skip_notify")).toBe("true");
    expect(calls[0]!.url.searchParams.get("skip_email")).toBe("true");
    expect(calls[0]!.url.searchParams.get("path_type")).toBe("blood");
    const quick = await call("get_relationship_path", { from_profile_id: "1", to_profile_id: "2", wait_seconds: 0 });
    expect(quick.data.status).toBe("done");
  });

  it("compare_profiles, search, media lists, tree matches", async () => {
    const { call, calls } = await setup([
      on("GET", "profile-1/compare/profile-2", () => json({ results: [ancestorsResponse, { nodes: {} }] })),
      on("GET", "profile/search", () => json({ results: [{ id: "profile-7", name: "Hans" }], next_page: "x" })),
      on("GET", "profile-1/documents", () => json({ results: [] })),
      on("GET", "profile-1/tree_matches", () => json({ results: [1] })),
    ]);
    const cmp = await call("compare_profiles", { profile_id: "1", other_profile_id: "2" });
    expect(cmp.data.results[0].focus.id).toBe("profile-1");
    const s = await call("search_profiles", { names: "Hans Botha", per_page: 10 });
    expect(s.data.results).toEqual([{ id: "profile-7", name: "Hans" }]);
    expect(calls[1]!.url.searchParams.get("names")).toBe("Hans Botha");
    await call("list_profile_media", { profile_id: "1", kind: "documents", page: 2 });
    expect(calls[2]!.url.searchParams.get("page")).toBe("2");
    expect((await call("get_tree_matches", { profile_id: "1" })).data).toEqual({ results: [1] });
  });
});

describe("profile writes", () => {
  const before = on("GET", "profile-1", () => json({ id: "profile-1", first_name: "Jn", about_me: "Old." }));

  it("update_profile previews, then writes and logs", async () => {
    const { call, calls, auditLines } = await setup([before, on("POST", "profile-1/update", () => json({ id: "profile-1" }))]);
    const dry = await call("update_profile", { profile_id: "1", first_name: "Jan", dry_run: true });
    expect(dry.data).toEqual({ dry_run: true, profile: "profile-1", before: { first_name: "Jn" }, after: { first_name: "Jan" } });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    const res = await call("update_profile", {
      profile_id: "1",
      first_name: "Jan",
      nicknames: ["Jannie", "JJ"],
      birth: { date: { year: 1900, circa: true } },
    });
    expect(res.data.before.first_name).toBe("Jn");
    const post = calls.find((c) => c.method === "POST")!;
    expect(formOf(post)).toEqual({ first_name: "Jan", nicknames: "Jannie,JJ", "birth[date][year]": "1900", "birth[date][circa]": "true" });
    expect(auditLines()[0]).toMatchObject({ tool: "update_profile", target: "profile-1", outcome: "ok" });
  });

  it("update_profile needs at least one field", async () => {
    const { call } = await setup([]);
    expect((await call("update_profile", { profile_id: "1" })).text).toMatch(/No fields/);
  });

  it("append_about_note keeps the existing text", async () => {
    const { call, calls } = await setup([before, on("POST", "profile-1/update", () => json({}))]);
    const dry = await call("append_about_note", { profile_id: "1", note: "Baptised 1801.", date: "2026-10-27", dry_run: true });
    expect(dry.data.appended).toBe("Research note (2026-10-27):\nBaptised 1801.");
    await call("append_about_note", { profile_id: "1", note: "Baptised 1801.", date: "2026-10-27" });
    expect(formOf(calls.at(-1)!).about_me).toBe("Old.\n\nResearch note (2026-10-27):\nBaptised 1801.");
  });

  it("structural writes are blocked at the default level", async () => {
    const { call, calls } = await setup([]);
    for (const [name, args] of [
      ["add_relative", { profile_id: "1", relation: "parent", first_name: "X", confirm: true }],
      ["merge_profiles", { profile_id: "1", duplicate_profile_id: "2", confirm: true }],
      ["delete_profile", { profile_id: "1", confirm: true }],
      ["create_profile", { first_name: "X", confirm: true }],
      ["add_to_union", { union_id: "5", role: "child", confirm: true }],
      ["delete_media", { kind: "photo", id: "5", confirm: true }],
    ] as const) {
      const res = await call(name, args);
      expect(res.isError, name).toBe(true);
      expect(res.text).toMatch(/GENI_WRITE_LEVEL=full/);
    }
    expect(calls).toHaveLength(0);
  });

  it("read-only mode blocks safe writes too", async () => {
    const { call } = await setup([], { writeLevel: "readonly" });
    expect((await call("update_profile", { profile_id: "1", first_name: "A" })).text).toMatch(/read-only/);
    expect((await call("save_app_metadata", { data: { a: 1 } })).text).toMatch(/read-only/);
  });

  it("full level still needs confirm, then performs the change", async () => {
    const { call, calls, auditLines } = await setup(
      [
        on("POST", "profile-1/add-partner", () => json({ id: "profile-3" })),
        on("POST", "profile-1/merge/profile-2", () => json({ result: "merged" })),
        on("GET", "profile-1", () => json({ id: "profile-1" })),
        on("POST", "profile-1/delete", () => json({ result: "deleted" })),
        on("POST", "profile/add", () => json({ id: "profile-8" })),
      ],
      { writeLevel: "full" },
    );
    const unconfirmed = await call("add_relative", { profile_id: "1", relation: "partner", first_name: "Anna" });
    expect(unconfirmed.text).toMatch(/confirm: true/);
    const added = await call("add_relative", {
      profile_id: "1",
      relation: "partner",
      first_name: "Anna",
      marriage: { date: { year: 1945 } },
      confirm: true,
    });
    expect(added.data).toEqual({ id: "profile-3" });
    expect(formOf(calls.at(-1)!)).toMatchObject({ "marriage[date][year]": "1945" });
    expect((await call("merge_profiles", { profile_id: "1", duplicate_profile_id: "1", confirm: true })).text).toMatch(/same profile/);
    expect((await call("merge_profiles", { profile_id: "1", duplicate_profile_id: "2", confirm: true })).data).toEqual({ result: "merged" });
    expect((await call("delete_profile", { profile_id: "1", confirm: true })).data).toEqual({ result: "deleted" });
    expect((await call("create_profile", { first_name: "Solo", confirm: true })).data).toEqual({ id: "profile-8" });
    expect(auditLines().map((l: { tool: string }) => l.tool)).toEqual(["add_relative", "merge_profiles", "delete_profile", "create_profile"]);
  });

  it("follow_profile and failed writes are logged", async () => {
    const { call, auditLines } = await setup([
      on("POST", "profile-1/follow", () => json({ id: "profile-1" })),
      on("POST", "profile-1/unfollow", () => json({ error: { message: "nope" } }, 400)),
    ]);
    await call("follow_profile", { profile_id: "1", follow: true });
    const failed = await call("follow_profile", { profile_id: "1", follow: false });
    expect(failed.isError).toBe(true);
    expect(auditLines().map((l: { outcome: string }) => l.outcome)).toEqual(["ok", "error"]);
  });
});

describe("unions", () => {
  it("gets, updates and adds to unions", async () => {
    const { call, calls } = await setup(
      [
        on("GET", "union-5", () => json({ id: "union-5", marriage: { date: { year: 1940 } } })),
        on("GET", "union", () => json({ results: [] })),
        on("POST", "union-5/update", () => json({ id: "union-5" })),
        on("POST", "union-5/add-child", () => json({ id: "profile-9" })),
      ],
      { writeLevel: "full" },
    );
    expect((await call("get_union", { union_ids: ["5"] })).data.id).toBe("union-5");
    await call("get_union", { union_ids: ["5", "union-6"] });
    expect(calls[1]!.url.searchParams.get("ids")).toBe("5,6");
    const dry = await call("update_union", { union_id: "5", marriage: { date: { year: 1941 } }, dry_run: true });
    expect(dry.data.before.marriage.date.year).toBe(1940);
    await call("update_union", { union_id: "5", marriage: { location: { place_name: "Paarl" } } });
    expect(formOf(calls.at(-1)!)).toEqual({ "marriage[location][place_name]": "Paarl" });
    expect((await call("update_union", { union_id: "5" })).text).toMatch(/marriage and\/or divorce/);
    await call("add_to_union", { union_id: "5", role: "child", first_name: "Kid", confirm: true });
    expect(formOf(calls.at(-1)!)).toEqual({ first_name: "Kid" });
    const posts = calls.length;
    for (const extra of [{ nicknames: ["K"] }, { names: { af: { first_name: "Jan" } } }, { title: "Ds." }]) {
      const res = await call("add_to_union", { union_id: "5", role: "child", first_name: "Kid", confirm: true, ...extra });
      expect(res.text).toMatch(/does not accept names, nicknames or title/);
    }
    expect(calls).toHaveLength(posts);
  });
});

describe("media", () => {
  it("creates documents from text and from files", async () => {
    const { call, calls, uploadDir, auditLines } = await setup([
      on("POST", "document/add", () => json({ id: "document-1" })),
      on("POST", "profile-1/add-document", () => json({ id: "document-2" })),
    ]);
    expect((await call("create_document", { title: "T" })).text).toMatch(/at least one/);
    await call("create_document", { title: "Baptism", text: "Jan, 1801", date: { year: 1801 }, labels: ["NGK", "Paarl"] });
    expect(formOf(calls[0]!)).toEqual({ title: "Baptism", text: "Jan, 1801", date: '{"year":1801}', labels: "NGK,Paarl" });

    const file = join(uploadDir, "scan.jpg");
    writeFileSync(file, Buffer.from("img"));
    const unconfirmed = await call("create_document", { title: "Scan", file_path: file });
    expect(unconfirmed.text).toMatch(/upload scan\.jpg \(3 bytes\).*confirm: true/);
    expect(calls).toHaveLength(1);
    await call("create_document", { title: "Scan", file_path: file, confirm: true });
    expect(formOf(calls[1]!)).toMatchObject({ file: Buffer.from("img").toString("base64"), file_name: "scan.jpg", content_type: "image/jpeg" });
    await call("create_document", { title: "Scan", file_path: file, profile_id: "1", confirm: true });
    expect(formOf(calls[2]!).file_name).toBeUndefined();
    expect(JSON.stringify(auditLines())).not.toContain(Buffer.from("img").toString("base64"));
    expect((await call("create_document", { title: "x", file_path: "relative.jpg" })).text).toMatch(/absolute/);
  });

  it("uploads photos as multipart and profile media as base64", async () => {
    const { call, calls, uploadDir } = await setup([
      on("POST", "photo/add", () => json({ id: "photo-1" })),
      on("POST", "profile-1/add-video", () => json({ id: "video-1" })),
      on("POST", "profile-1/add-mugshot", () => json({ id: "photo-2" })),
    ]);
    const file = join(uploadDir, "pic.png");
    writeFileSync(file, Buffer.from("png"));
    expect((await call("upload_media", { kind: "photo", file_path: file, title: "Grave" })).text).toMatch(/confirm: true/);
    expect((await call("set_profile_photo", { profile_id: "1", file_path: file })).text).toMatch(/confirm: true/);
    expect(calls).toHaveLength(0);
    await call("upload_media", { kind: "photo", file_path: file, title: "Grave", album_id: "3", date: { year: 1990 }, confirm: true });
    const body = calls[0]!.body as FormData;
    expect(body.get("title")).toBe("Grave");
    expect(body.get("album_id")).toBe("3");
    expect((body.get("file") as File).name).toBe("pic.png");
    await call("upload_media", { kind: "video", file_path: file, title: "Clip", profile_id: "1", confirm: true });
    expect(formOf(calls[1]!).file).toBe(Buffer.from("png").toString("base64"));
    expect((await call("upload_media", { kind: "photo", file_path: file, title: "x", album_id: "3", profile_id: "1" })).text).toMatch(/album_id/);
    expect((await call("set_profile_photo", { profile_id: "1" })).text).toMatch(/exactly one/);
    await call("set_profile_photo", { profile_id: "1", photo_id: "photo-44" });
    expect(formOf(calls[2]!)).toEqual({ photo_id: "44" });
  });

  it("gets, lists, updates, tags, comments, deletes and albums", async () => {
    let tagCalls = 0;
    const { call, calls } = await setup(
      [
        on("GET", "document-1", () => json({ id: "document-1", title: "Old" })),
        on("GET", "photo", () => json({ results: [] })),
        on("GET", "document-1/projects", () => json({ results: [] })),
        on("POST", "document-1/update", () => json({ id: "document-1" })),
        (c) =>
          c.url.pathname.startsWith("/api/document-1/tag/")
            ? ++tagCalls === 2
              ? json({ error: "no access" }, 403)
              : json({ id: "document-1" })
            : undefined,
        on("POST", "photo-2/comment", () => json({ results: [] })),
        on("GET", "photo-2", () => json({ id: "photo-2" })),
        on("POST", "photo-2/delete", () => json({})),
        on("POST", "photo_album/add", () => json({ id: "photo_album-1" })),
        on("POST", "photo_album-1/update", () => json({ id: "photo_album-1" })),
      ],
      { writeLevel: "full" },
    );
    expect((await call("get_media", { kind: "document", ids: ["1"] })).data.title).toBe("Old");
    await call("get_media", { kind: "photo", ids: ["photo-1", "2"] });
    expect(calls[1]!.url.searchParams.get("ids")).toBe("1,2");
    await call("media_related", { kind: "document", id: "1", list: "projects", count: true });
    expect(calls[2]!.url.searchParams.get("count")).toBe("true");
    expect((await call("media_related", { kind: "photo", id: "1", list: "projects" })).text).toMatch(/supports list/);

    const dry = await call("update_media", { kind: "document", id: "1", title: "New", labels: ["a"], dry_run: true });
    expect(dry.data.after).toEqual({ title: "New", labels: "a" });
    await call("update_media", { kind: "document", id: "1", title: "New" });
    expect((await call("update_media", { kind: "video", id: "1", description: "x" })).text).toMatch(/description/);
    expect((await call("update_media", { kind: "photo", id: "1", labels: ["x"] })).text).toMatch(/labels/);
    expect((await call("update_media", { kind: "photo", id: "1" })).text).toMatch(/No fields/);

    const tags = await call("tag_media", { kind: "document", id: "1", profile_ids: ["1", "2"] });
    expect(tags.isError).toBe(true);
    expect(tags.text).toMatch(/1 of 2 tag changes failed/);
    expect(tags.text).toContain('"profile": "profile-1",\n      "ok": true');
    const before = calls.length;
    expect((await call("tag_media", { kind: "document", id: "1", profile_ids: ["1", "union-9"] })).text).toMatch(/Expected a profile id/);
    expect(calls).toHaveLength(before);
    await call("add_comment", { kind: "photo", id: "2", text: "Nice" });
    expect((await call("delete_media", { kind: "photo", id: "2" })).text).toMatch(/confirm/);
    await call("delete_media", { kind: "photo", id: "2", confirm: true });
    expect((await call("save_album", { name: "Graves" })).data.id).toBe("photo_album-1");
    await call("save_album", { name: "Graves 2", album_id: "1" });
    expect(calls.at(-1)!.url.pathname).toBe("/api/photo_album-1/update");
  });
});

describe("upload policy", () => {
  it("refuses files outside the upload folders, hidden files, the config folder and unknown types", async () => {
    const { call, uploadDir, config } = await setup([]);
    const { mkdirSync } = await import("node:fs");
    const secret = join(config.configDir, "tokens.jpg");
    writeFileSync(secret, "x");
    mkdirSync(join(uploadDir, ".ssh"));
    writeFileSync(join(uploadDir, ".ssh", "id.jpg"), "x");
    writeFileSync(join(uploadDir, "notes.json"), "{}");
    mkdirSync(join(uploadDir, "folder.jpg"));
    const outside = join(config.configDir, "..", "outside.jpg");
    writeFileSync(outside, "x");
    const attempt = (file_path: string) => call("create_document", { title: "x", file_path });
    expect((await attempt(secret)).text).toMatch(/Refusing to upload from/);
    expect((await attempt(join(uploadDir, ".ssh", "id.jpg"))).text).toMatch(/hidden/);
    expect((await attempt(join(uploadDir, "notes.json"))).text).toMatch(/Only these file types/);
    expect((await attempt(join(uploadDir, "folder.jpg"))).text).toMatch(/not a file/);
    expect((await attempt(outside)).text).toMatch(/outside the upload folders/);
  });
});

describe("every write tool is guarded", () => {
  // Valid arguments for every write tool, so each call reaches the write guard instead of failing validation.
  const WRITE_ARGS: Record<string, Record<string, unknown>> = {
    update_profile: { profile_id: "1", first_name: "X" },
    append_about_note: { profile_id: "1", note: "x" },
    create_profile: { first_name: "X", confirm: true },
    add_relative: { profile_id: "1", relation: "child", first_name: "X", confirm: true },
    merge_profiles: { profile_id: "1", duplicate_profile_id: "2", confirm: true },
    delete_profile: { profile_id: "1", confirm: true },
    follow_profile: { profile_id: "1", follow: true },
    update_union: { union_id: "5", marriage: { date: { year: 1900 } } },
    add_to_union: { union_id: "5", role: "child", first_name: "X", confirm: true },
    create_document: { title: "T", text: "x" },
    upload_media: { kind: "photo", file_path: "/tmp/x.jpg", title: "T", confirm: true },
    set_profile_photo: { profile_id: "1", photo_id: "2" },
    update_media: { kind: "photo", id: "1", title: "T" },
    tag_media: { kind: "photo", id: "1", profile_ids: ["1"] },
    add_comment: { kind: "photo", id: "1", text: "x" },
    delete_media: { kind: "photo", id: "1", confirm: true },
    save_album: { name: "A" },
    add_to_project: { project_id: "6", profile_ids: ["1"] },
    update_project: { project_id: "6", name: "P" },
    save_app_metadata: { data: { a: 1 } },
  };

  it("read-only mode refuses all tools marked as writes, before any request", async () => {
    const { call, calls } = await setup([], { writeLevel: "readonly" });
    const writes = ALL_TOOLS.filter((t) => t.write);
    expect(writes.map((t) => t.name).sort()).toEqual(Object.keys(WRITE_ARGS).sort());
    for (const t of writes) {
      expect((await call(t.name, WRITE_ARGS[t.name])).text, t.name).toMatch(/read-only mode/);
    }
    expect(calls).toHaveLength(0);
  });

  it("every tool whose name suggests a change is marked as a write", () => {
    const verbs = /^(update|append|create|add|merge|delete|follow|upload|set|tag|save)_/;
    for (const t of ALL_TOOLS.filter((t) => verbs.test(t.name))) expect(t.write, t.name).toBeDefined();
  });
});

describe("projects, surnames, account, misc", () => {
  it("covers the collection tools", async () => {
    const { call, calls } = await setup([
      on("GET", "project-6", () => json({ id: "project-6" })),
      on("GET", "project", () => json({ results: [] })),
      on("GET", "project/search", () => json({ results: [] })),
      on("GET", "project-6/collaborators", () => json({ results: [] })),
      on("POST", "project-6/add_profiles", () => json({ results: [] })),
      on("POST", "project-6/add_documents", () => json({ results: [] })),
      on("POST", "project-6/update", () => json({ id: "project-6" })),
      on("GET", "surname-3", () => json({ id: "surname-3" })),
      on("GET", "surname-3/profiles", () => json({ results: [] })),
      on("GET", "user/managed-profiles", () => json({ results: [] })),
      on("GET", "user/metadata", () => json({ data: {} })),
      on("POST", "user/update-metadata", () => json({ data: { a: 1 } })),
      on("GET", "revision-9", () => json({ id: "revision-9" })),
      on("GET", "stats/world-family-tree", () => json({ size: 1 })),
      on("GET", "stats", () => json({ stats: [] })),
      on("GET", "user", () => json({ name: "Test User" })),
      on("GET", "profile", () => json({ id: "profile-1" })),
    ]);
    expect((await call("get_project", { project_ids: ["6"] })).data.id).toBe("project-6");
    await call("get_project", { project_ids: ["6", "7"] });
    await call("search_projects", { query: "Huguenots" });
    expect(calls[2]!.url.searchParams.get("q")).toBe("Huguenots");
    await call("project_members", { project_id: "6", list: "collaborators" });
    expect((await call("add_to_project", { project_id: "6" })).text).toMatch(/profile_ids/);
    await call("add_to_project", { project_id: "6", profile_ids: ["1", "6000000000000000001"], document_ids: ["4"] });
    expect(formOf(calls[4]!)).toEqual({ profile_ids: "profile-1,g6000000000000000001" });
    expect(formOf(calls[5]!)).toEqual({ ids: "document-4" });
    expect((await call("update_project", { project_id: "6" })).text).toMatch(/No fields/);
    await call("update_project", { project_id: "6", names: { af: "Hugenote" } });
    expect(formOf(calls.at(-1)!)).toEqual({ "names[af]": "Hugenote" });
    expect((await call("get_surname", { surname_id: "3" })).data.id).toBe("surname-3");
    await call("surname_members", { surname_id: "3", list: "profiles", per_page: 5 });
    await call("list_mine", { list: "managed-profiles" });
    expect((await call("get_app_metadata")).data).toEqual({ data: {} });
    await call("save_app_metadata", { data: { a: 1 } });
    expect(formOf(calls.at(-1)!)).toEqual({ data: '{"a":1}' });
    expect((await call("save_app_metadata", { data: { x: "y".repeat(600) } })).text).toMatch(/512/);
    expect((await call("geni_raw_get", { path: "profile-1/delete" })).text).toMatch(/only reads/);
    expect((await call("geni_raw_get", { path: "profile-1/merge/profile-2" })).text).toMatch(/only reads/);
    expect((await call("get_revision", { revision_id: "9" })).data.id).toBe("revision-9");
    expect((await call("world_tree_stats")).data.world_family_tree.size).toBe(1);
    expect((await call("get_user")).data.user.name).toBe("Test User");
    expect((await call("geni_raw_get", { path: "user/metadata", query: { a: 1 } })).data).toEqual({ data: {} });
    expect((await call("geni_raw_get", { path: "https://evil.example" })).isError).toBe(true);
  });
});

describe("auth tools", () => {
  it("auth_status reports the session", async () => {
    const { call } = await setup([]);
    const res = await call("auth_status");
    expect(res.data).toMatchObject({ logged_in: true, token_expired: false, can_refresh: true, write_level: "safe" });
  });

  it("validates and logs out", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      new Response(JSON.stringify({ result: String(url).includes("invalidate") ? "revoked" : "OK" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { call, tokens } = await setup([]);
    expect((await call("auth_status", { validate: true })).data.geni_says).toEqual({ result: "OK" });
    expect((await call("auth_logout")).data.geni_says).toEqual({ result: "revoked" });
    expect(await tokens.load()).toBeNull();
    expect((await call("get_user")).text).toMatch(/auth_start/);
  });

  it("auth_complete exchanges a pasted redirect URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "fresh", expires_in: 86400 }))));
    const { call, tokens } = await setup([], { loggedIn: false });
    const res = await call("auth_complete", { code_or_url: "http://localhost:3000/oauth/callback?code=abc" });
    expect(res.data).toEqual({ logged_in: true });
    expect((await tokens.load())?.accessToken).toBe("fresh");
  });

  it("auth_start listens for the redirect and saves the token", async () => {
    const realFetch = globalThis.fetch;
    const { call, tokens, config } = await setup([], { loggedIn: false });
    Object.assign(config, { redirectUri: "http://127.0.0.1:38920/oauth/callback" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) =>
        String(url).includes("request_token")
          ? new Response(JSON.stringify({ access_token: "via-listener", refresh_token: "r" }))
          : realFetch(url, init),
      ),
    );
    const started = await call("auth_start");
    const state = new URL(started.data.authorization_url).searchParams.get("state");
    expect((await call("auth_complete", { code_or_url: "http://x/cb?code=1&state=wrong" })).text).toMatch(/older login/);
    await realFetch(`http://127.0.0.1:38920/oauth/callback?code=abc&state=${state}`);
    await vi.waitFor(async () => expect((await tokens.load())?.accessToken).toBe("via-listener"));
    await vi.waitFor(async () => expect((await call("auth_status")).data.pending_login.status).toBe("done"));
  });

  it("auth_start falls back to manual when the listener cannot start", async () => {
    const { call, config } = await setup([], { loggedIn: false });
    Object.assign(config, { redirectUri: "https://example.com/cb" });
    const res = await call("auth_start");
    expect(res.data.listener_error).toMatch(/http:\/\//);
    expect(res.data.next_step).toMatch(/auth_complete/);
  });
});

describe("QA regressions", () => {
  it("geni_raw_get refuses percent-encoded and ;-separated paths that could hide a write", async () => {
    const { call, calls } = await setup([], { writeLevel: "readonly" });
    for (const path of ["profile-1/%64elete", "profile-1/%61dd-child", "profile-1;delete", "profile-1/x%2564elete", "profile-1/de\tlete", "profile-1/de\nlete", "profile-1/DE\rLETE"]) {
      expect((await call("geni_raw_get", { path })).text, path).toMatch(/path cannot contain %, ;, spaces or control characters/);
    }
    const query = await call("geni_raw_get", { path: "profile-1/documents?q=a%20b" });
    expect(query.text).toMatch(/Pass query parameters in the query argument/);
    expect(query.text).not.toMatch(/write tool/);
    expect(calls).toHaveLength(0);
  });

  it("previews and raw reads keep cleared and empty values", async () => {
    const { call } = await setup([
      on("GET", "profile-1", () => json({ id: "profile-1", about_me: "Old." })),
      on("GET", "profile-1/documents", () => json({ results: [] })),
    ]);
    const dry = await call("update_profile", { profile_id: "1", about_me: "", dry_run: true });
    expect(dry.data.after).toEqual({ about_me: "" });
    expect((await call("geni_raw_get", { path: "profile-1/documents" })).data).toEqual({ results: [] });
  });

  it("add_to_project checks every id before writing and reports a partial failure", async () => {
    const { call, calls } = await setup([
      on("POST", "project-6/add_profiles", () => json({ result: "ok" })),
      on("POST", "project-6/add_documents", () => json({ error: { message: "nope" } }, 403)),
    ]);
    expect((await call("add_to_project", { project_id: "6", profile_ids: ["1"], document_ids: ["profile-2"] })).text).toMatch(
      /Expected a document id/,
    );
    expect(calls).toHaveLength(0);
    const res = await call("add_to_project", { project_id: "6", profile_ids: ["1"], document_ids: ["4"] });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/profiles were added but adding documents failed/);
    expect(res.text).toContain('"result": "ok"');
  });

  it("auth_complete needs the matching state while a login is pending", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "fresh" }))));
    const { call, config, tokens } = await setup([], { loggedIn: false });
    Object.assign(config, { redirectUri: "https://example.com/cb" });
    const state = new URL((await call("auth_start")).data.authorization_url).searchParams.get("state");
    expect((await call("auth_complete", { code_or_url: "abc" })).text).toMatch(/full redirect URL/);
    expect((await call("auth_complete", { code_or_url: "http://x/cb?code=abc" })).text).toMatch(/full redirect URL/);
    expect(await tokens.load()).toBeNull();
    expect((await call("auth_complete", { code_or_url: `http://x/cb?code=abc&state=${state}` })).data).toEqual({ logged_in: true });
  });
});
