// Projects, surnames, the user's own lists, app metadata, revisions, stats and a raw GET fallback.

import { z } from "zod";
import { normalizeId, profileId } from "../ids.js";
import { auditedWrite, FieldsParam, PageFields, pageQuery, PartialFailureError, tool } from "./shared.js";

const ProjectId = z.string().describe("Project id, e.g. 'project-6' or 6");

const MY_LISTS = [
  "managed-profiles",
  "max-family",
  "followed-profiles",
  "followed-projects",
  "followed-documents",
  "followed-surnames",
  "uploaded-documents",
  "uploaded-photos",
  "uploaded-videos",
  "my-albums",
  "my-labels",
] as const;

const METADATA_MAX_BYTES = 512;

/** Path segments of Geni write endpoints, refused by geni_raw_get even though it only sends GET. */
const WRITE_SEGMENT = /^(add.*|delete|merge|update.*|tag|untag|comment|follow|unfollow|invalidate_token)$/;

export const collectionTools = [
  tool({
    name: "get_project",
    title: "Get projects",
    description: "Geni projects (collaborative research pages): name and description in each language. Up to 50 ids.",
    input: { project_ids: z.array(ProjectId).min(1).max(50), ...FieldsParam },
    handler: async ({ project_ids, fields }, ctx) => {
      const ids = project_ids.map((p) => normalizeId("project", p));
      const query = { fields: fields?.join(",") };
      if (ids.length === 1) return ctx.client.get(ids[0]!, query);
      return ctx.client.get("project", { ...query, ids: ids.map((i) => i.replace(/^project-/, "")).join(",") });
    },
  }),

  tool({
    name: "search_projects",
    title: "Search projects",
    description: "Finds Geni projects whose name or description matches the text, e.g. 'Huguenots' or 'Graaff-Reinet'.",
    input: { query: z.string().min(1), ...PageFields },
    handler: async ({ query, page, per_page }, ctx) => ctx.client.get("project/search", { q: query, page, per_page }),
  }),

  tool({
    name: "project_members",
    title: "Project profiles, collaborators or followers",
    description: "Lists the profiles tagged in a project, or its collaborators or followers.",
    input: { project_id: ProjectId, list: z.enum(["profiles", "collaborators", "followers"]), ...PageFields, ...FieldsParam },
    handler: async ({ project_id, list, ...rest }, ctx) =>
      ctx.client.get(`${normalizeId("project", project_id)}/${list}`, pageQuery(rest)),
  }),

  tool({
    name: "add_to_project",
    title: "Add profiles or documents to a project",
    description: "Adds profiles and/or documents to a project you collaborate on. Geni has no way to remove them via the API.",
    write: "safe",
    input: {
      project_id: ProjectId,
      profile_ids: z.array(z.string()).max(50).optional(),
      document_ids: z.array(z.string()).max(50).optional(),
    },
    handler: async ({ project_id, profile_ids, document_ids }, ctx) => {
      if (!profile_ids?.length && !document_ids?.length) throw new Error("Give profile_ids and/or document_ids.");
      const id = normalizeId("project", project_id);
      // Check every id before the first write, so a bad id cannot leave the project half-updated.
      // The docs mix node ids and GUIDs as "g<guid>", not "profile-g<guid>".
      const profiles = profile_ids?.map((p) => profileId(p).replace(/^profile-(g\d+)$/, "$1")).join(",");
      const documents = document_ids?.map((d) => normalizeId("document", d)).join(",");
      const out: Record<string, unknown> = {};
      if (profiles) {
        out.profiles = await auditedWrite(ctx, { tool: "add_to_project", target: id, request: { profile_ids: profiles } }, () =>
          ctx.client.post(`${id}/add_profiles`, { profile_ids: profiles }),
        );
      }
      if (documents) {
        try {
          out.documents = await auditedWrite(ctx, { tool: "add_to_project", target: id, request: { ids: documents } }, () =>
            ctx.client.post(`${id}/add_documents`, { ids: documents }),
          );
        } catch (err) {
          if (!profiles) throw err;
          const reason = err instanceof Error ? err.message : String(err);
          throw new PartialFailureError(`The profiles were added but adding documents failed: ${reason}`, out);
        }
      }
      return out;
    },
  }),

  tool({
    name: "update_project",
    title: "Update a project",
    description: "Changes a project's name and/or description. names/descriptions set them per language, e.g. {\"af\": \"...\"}.",
    write: "safe",
    input: {
      project_id: ProjectId,
      name: z.string().optional(),
      description: z.string().optional(),
      names: z.record(z.string(), z.string()).optional(),
      descriptions: z.record(z.string(), z.string()).optional(),
    },
    handler: async ({ project_id, ...fields }, ctx) => {
      const id = normalizeId("project", project_id);
      const form = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(form).length === 0) throw new Error("No fields to change were given.");
      const before = await ctx.client.get(id);
      return auditedWrite(ctx, { tool: "update_project", target: id, request: form, before }, () =>
        ctx.client.post(`${id}/update`, form),
      );
    },
  }),

  tool({
    name: "get_surname",
    title: "Get a surname page",
    description: "A Geni surname page by its id (Geni has no lookup by surname text; ids appear on followed-surnames and geni.com/surnames URLs).",
    input: { surname_id: z.string() },
    handler: async ({ surname_id }, ctx) => ctx.client.get(normalizeId("surname", surname_id)),
  }),

  tool({
    name: "surname_members",
    title: "Surname profiles or followers",
    description: "Profiles with a surname, or the users following it. Set count: true for just the number.",
    input: {
      surname_id: z.string(),
      list: z.enum(["profiles", "followers"]),
      count: z.boolean().optional(),
      ...PageFields,
      ...FieldsParam,
    },
    handler: async ({ surname_id, list, count, ...rest }, ctx) =>
      ctx.client.get(`${normalizeId("surname", surname_id)}/${list}`, { ...pageQuery(rest), count }),
  }),

  tool({
    name: "list_mine",
    title: "My Geni lists",
    description:
      "The logged-in user's lists: managed-profiles, max-family (blood relatives), followed profiles/projects/" +
      "documents/surnames, uploaded documents/photos/videos, photo albums, and document labels. Paged, 50 max per page.",
    input: { list: z.enum(MY_LISTS), ...PageFields, ...FieldsParam },
    handler: async ({ list, ...rest }, ctx) => ctx.client.get(`user/${list}`, pageQuery(rest)),
  }),

  tool({
    name: "get_app_metadata",
    title: "Read app notes on Geni",
    description: "Reads the up-to-512-byte JSON note this app can keep per Geni user (e.g. a research bookmark).",
    input: {},
    handler: async (_args, ctx) => ctx.client.get("user/metadata"),
  }),

  tool({
    name: "save_app_metadata",
    title: "Save app notes on Geni",
    description: "Replaces this app's per-user JSON note on Geni (512 bytes max once encoded).",
    write: "safe",
    input: { data: z.record(z.string(), z.unknown()) },
    handler: async ({ data }, ctx) => {
      const json = JSON.stringify(data);
      if (Buffer.byteLength(json) > METADATA_MAX_BYTES) throw new Error(`data is over ${METADATA_MAX_BYTES} bytes once encoded.`);
      return auditedWrite(ctx, { tool: "save_app_metadata", target: "user/update-metadata", request: data }, () =>
        ctx.client.post("user/update-metadata", { data: json }),
      );
    },
  }),

  tool({
    name: "get_revision",
    title: "Get a revision",
    description: "One change record from a profile's history: what was done, when, and an HTML story describing it.",
    input: { revision_id: z.string() },
    handler: async ({ revision_id }, ctx) => ctx.client.get(normalizeId("revision", revision_id)),
  }),

  tool({
    name: "world_tree_stats",
    title: "World Family Tree size",
    description: "Number of profiles in Geni's World Family Tree, plus the other statistics Geni publishes.",
    input: {},
    handler: async (_args, ctx) => ({
      world_family_tree: await ctx.client.get("stats/world-family-tree"),
      stats: await ctx.client.get("stats"),
    }),
  }),

  tool({
    name: "geni_raw_get",
    title: "Raw Geni API GET",
    description:
      "Read-only escape hatch for any Geni API path not covered by another tool, e.g. 'profile-123/tree_matches'. " +
      "GET only; never changes data.",
    input: {
      path: z.string().min(1).describe("Path under https://www.geni.com/api/, e.g. 'profile-123/documents'"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    },
    keepEmpty: true,
    handler: async ({ path, query }, ctx) => {
      // Encoded characters, ";", whitespace and control characters (which URL parsing strips) could
      // spell a write segment, so refuse them and check the path of the URL that would really be sent.
      const sent = new URL(ctx.client.buildUrl(path)).pathname;
      const segments = [...path.split(/[/?#]/), ...sent.split("/")].map((p) => p.toLowerCase());
      if (/[\u0000- \u007f%;]/.test(path) || segments.some((p) => WRITE_SEGMENT.test(p))) {
        throw new Error("geni_raw_get only reads. Use the matching write tool for this endpoint.");
      }
      return ctx.client.get(path, query);
    },
  }),
];
