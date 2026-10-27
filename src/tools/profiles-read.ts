// Read-only profile tools: lookups, family, ancestors, descendants, paths, search.

import { z } from "zod";
import { profileId } from "../ids.js";
import { buildAhnentafel } from "../tree/ahnentafel.js";
import { FamilyGraph, type FamilyResponse } from "../tree/graph.js";
import { dropEmpty, summarizeProfile } from "../tree/summarize.js";
import { checkCancelled, FieldsParam, PageFields, pageQuery, tool, type ToolContext } from "./shared.js";

export const DEFAULT_PROFILE_FIELDS = [
  "id", "guid", "name", "display_name", "title", "first_name", "middle_name", "last_name", "maiden_name",
  "suffix", "nicknames", "names", "gender", "is_alive", "birth", "baptism", "death", "burial",
  "cause_of_death", "occupation", "current_residence", "about_me", "unions", "managers", "creator",
  "public", "locked", "claimed", "big_tree", "master_profile", "merged_into", "merge_pending",
  "requested_merges", "project_ids", "profile_url", "created_at", "updated_at",
].join(",");

const SUMMARY_FIELDS = "id,guid,name,display_name,first_name,last_name,gender,is_alive,birth,baptism,death,burial,profile_url";

const ProfileIdParam = z
  .string()
  .describe("Profile id: 'profile-123', a Geni ID like '6999999999999999999', 'g6000…', or a geni.com profile URL");

const MAX_PATH_WAIT_SECONDS = 60;
const PATH_POLL_INTERVAL_MS = 5_000;

/** Strips the type prefix for the `ids=` batch parameter. */
function batchId(id: string): string {
  return id.replace(/^profile-/, "");
}

export async function fetchFamily(ctx: ToolContext, id: string): Promise<FamilyGraph> {
  const response = await ctx.client.get<FamilyResponse>(`${id}/immediate-family`, {
    only_ids: true,
    fields: SUMMARY_FIELDS,
  });
  return new FamilyGraph(response);
}

function describeFamily(graph: FamilyGraph, id: string) {
  const summary = (pid: string) => summarizeProfile(graph.profiles.get(pid) ?? { id: pid });
  return dropEmpty({
    focus: summary(id),
    parents: graph.parents(id).map(summary),
    siblings: graph.siblings(id).map(summary),
    partners: graph.ownUnions(id).flatMap((u) =>
      (graph.unions.get(u)?.partners ?? []).filter((p) => p !== id).map((p) => ({ union: u, ...summary(p) })),
    ),
    children: graph.ownUnions(id).flatMap((u) =>
      (graph.unions.get(u)?.children ?? []).map((c) => ({ union: u, ...summary(c) })),
    ),
    parent_unions: graph.parentUnions(id),
  });
}

export const profileReadTools = [
  tool({
    name: "get_profile",
    title: "Get a Geni profile",
    description:
      "Full details of one profile: names, events (birth, baptism, death, burial), About text, unions, " +
      "managers, merge status and more. Leave profile_id empty for the logged-in user's own profile.",
    input: { profile_id: ProfileIdParam.optional(), ...FieldsParam },
    handler: async ({ profile_id, fields }, ctx) => {
      const path = profile_id ? profileId(profile_id) : "profile";
      return ctx.client.get(path, { fields: fields?.join(",") ?? DEFAULT_PROFILE_FIELDS, only_ids: true });
    },
  }),

  tool({
    name: "get_profiles",
    title: "Get several Geni profiles",
    description: "Fetches up to 50 profiles in one request. Returns compact summaries unless full: true.",
    input: {
      profile_ids: z.array(ProfileIdParam).min(1).max(50),
      full: z.boolean().optional().describe("Return all default fields instead of summaries"),
      ...FieldsParam,
    },
    handler: async ({ profile_ids, full, fields }, ctx) => {
      const ids = profile_ids.map((p) => batchId(profileId(p)));
      const response = await ctx.client.get<{ results?: Record<string, unknown>[] }>("profile", {
        ids: ids.join(","),
        only_ids: true,
        fields: fields?.join(",") ?? (full ? DEFAULT_PROFILE_FIELDS : SUMMARY_FIELDS),
      });
      if (full || fields || !Array.isArray(response.results)) return response;
      return { results: response.results.map(summarizeProfile) };
    },
  }),

  tool({
    name: "get_immediate_family",
    title: "Immediate family",
    description: "Parents, siblings, partners and children of a profile, with the union (couple) ids linking them.",
    input: { profile_id: ProfileIdParam },
    handler: async ({ profile_id }, ctx) => {
      const id = profileId(profile_id);
      return describeFamily(await fetchFamily(ctx, id), id);
    },
  }),

  tool({
    name: "get_ancestors",
    title: "Ancestors (Ahnentafel)",
    description:
      "Ancestors of a profile for up to 20 generations in one request, numbered Ahnentafel-style " +
      "(1 = the person, 2 = father, 3 = mother, 4 = paternal grandfather, ...). 'missing' lists the " +
      "numbers whose child is on Geni but who are not. Use raw: true for Geni's unprocessed response.",
    input: {
      profile_id: ProfileIdParam,
      generations: z.number().int().min(1).max(20).optional().describe("Generations above the person (default 5)"),
      raw: z.boolean().optional(),
    },
    handler: async ({ profile_id, generations, raw }, ctx) => {
      const gens = generations ?? 5;
      const response = await ctx.client.get<FamilyResponse>(`${profileId(profile_id)}/ancestors`, {
        generations: gens,
        only_ids: true,
      });
      if (raw) return response;
      const { rows, missing } = buildAhnentafel(new FamilyGraph(response), gens + 1);
      return { generations: gens, count: rows.length, missing, ancestors: rows };
    },
  }),

  tool({
    name: "get_descendants",
    title: "Descendants",
    description:
      "Descendants of a profile, found by walking immediate-family one person at a time (Geni has no " +
      "descendants endpoint). Each person costs one request, so keep generations and max_profiles small.",
    input: {
      profile_id: ProfileIdParam,
      generations: z.number().int().min(1).max(6).optional().describe("Default 2"),
      max_profiles: z.number().int().min(1).max(300).optional().describe("Stop after this many people (default 100)"),
    },
    handler: async ({ profile_id, generations, max_profiles }, ctx) => {
      const maxGen = generations ?? 2;
      const limit = max_profiles ?? 100;
      const root = profileId(profile_id);
      const seen = new Set([root]);
      const people: Array<Record<string, unknown>> = [];
      let frontier = [root];
      let truncated = false;

      for (let gen = 0; gen < maxGen && frontier.length > 0 && !truncated; gen++) {
        const next: string[] = [];
        for (const parent of frontier) {
          checkCancelled(ctx);
          if (seen.size > limit) {
            truncated = true;
            break;
          }
          const graph = await fetchFamily(ctx, parent);
          if (gen === 0) people.push({ generation: 0, ...summarizeProfile(graph.profiles.get(parent) ?? { id: parent }) });
          for (const child of graph.children(parent)) {
            if (seen.has(child)) continue;
            seen.add(child);
            next.push(child);
            people.push({
              generation: gen + 1,
              parent: parent,
              ...summarizeProfile(graph.profiles.get(child) ?? { id: child }),
            });
          }
        }
        frontier = next;
      }
      return { count: people.length, truncated, descendants: people };
    },
  }),

  tool({
    name: "get_relationship_path",
    title: "Relationship path",
    description:
      "How two profiles are related ('third cousin twice removed') and the chain of people linking them. " +
      "Geni calculates this in the background, so the tool polls for up to wait_seconds. Never sends Geni " +
      "notifications or emails.",
    input: {
      from_profile_id: ProfileIdParam,
      to_profile_id: ProfileIdParam,
      path_type: z.enum(["closest", "blood", "inlaw"]).optional(),
      refresh: z.boolean().optional().describe("Recalculate a path Geni already cached"),
      wait_seconds: z.number().int().min(0).max(MAX_PATH_WAIT_SECONDS).optional().describe("Default 30"),
    },
    handler: async ({ from_profile_id, to_profile_id, path_type, refresh, wait_seconds }, ctx) => {
      const path = `${profileId(from_profile_id)}/path-to/${profileId(to_profile_id)}`;
      const query = {
        path_type: path_type === "closest" ? undefined : path_type,
        refresh,
        skip_email: true,
        skip_notify: true,
      };
      const deadline = Date.now() + (wait_seconds ?? 30) * 1000;
      for (;;) {
        checkCancelled(ctx);
        const result = await ctx.client.get<{ status?: string }>(path, query);
        const done = result.status !== "pending" && result.status !== "overloaded";
        if (done || Date.now() + PATH_POLL_INTERVAL_MS > deadline) return result;
        await new Promise((r) => setTimeout(r, PATH_POLL_INTERVAL_MS));
      }
    },
  }),

  tool({
    name: "compare_profiles",
    title: "Compare two profiles",
    description: "Immediate families of two profiles side by side, to judge whether they are the same person before a merge.",
    input: { profile_id: ProfileIdParam, other_profile_id: ProfileIdParam },
    handler: async ({ profile_id, other_profile_id }, ctx) => {
      const a = profileId(profile_id);
      const b = profileId(other_profile_id);
      const response = await ctx.client.get<{ results?: FamilyResponse[] }>(`${a}/compare/${b}`, { only_ids: true });
      if (!Array.isArray(response.results)) return response;
      return {
        results: response.results.map((family) => {
          const graph = new FamilyGraph(family);
          return graph.focusId ? describeFamily(graph, graph.focusId) : family;
        }),
      };
    },
  }),

  tool({
    name: "search_profiles",
    title: "Search profiles",
    description:
      "Searches Geni profiles by name. Geni only documents name search, so filter the results on dates " +
      "and places yourself.",
    input: { names: z.string().min(1).describe("Name(s) to search for, e.g. 'Hans Christoffel Botha'"), ...PageFields },
    handler: async ({ names, page, per_page }, ctx) => {
      const response = await ctx.client.get<{ results?: Record<string, unknown>[] }>("profile/search", {
        names,
        page,
        per_page,
      });
      if (!Array.isArray(response.results)) return response;
      return { ...response, results: response.results.map(summarizeProfile) };
    },
  }),

  tool({
    name: "list_profile_media",
    title: "Profile documents, photos or videos",
    description: "Lists the documents (sources), photos or videos tagged on a profile.",
    input: {
      profile_id: ProfileIdParam,
      kind: z.enum(["documents", "photos", "videos"]),
      ...PageFields,
      ...FieldsParam,
    },
    handler: async ({ profile_id, kind, ...rest }, ctx) =>
      ctx.client.get(`${profileId(profile_id)}/${kind}`, pageQuery(rest)),
  }),

  tool({
    name: "get_tree_matches",
    title: "Tree matches (experimental)",
    description:
      "Geni's tree matches for a profile (possible matches in other trees). Not in Geni's API reference; " +
      "it may fail.",
    input: { profile_id: ProfileIdParam, ...PageFields },
    handler: async ({ profile_id, page, per_page }, ctx) =>
      ctx.client.get(`${profileId(profile_id)}/tree_matches`, { page, per_page }),
  }),
];
