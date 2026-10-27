// Profile edits. Every write is audit-logged; structural ones need GENI_WRITE_LEVEL=full and confirm: true.

import { z } from "zod";
import { profileId } from "../ids.js";
import { assertConfirmed } from "../safety/write-guard.js";
import { auditedWrite, Confirm, DryRun, EventSchema, PersonFields, toForm, tool, type ToolContext } from "./shared.js";

const ProfileIdParam = z.string().describe("Profile id, Geni ID or geni.com profile URL");

type Obj = Record<string, unknown>;

async function currentValues(ctx: ToolContext, id: string, keys: string[]): Promise<Obj> {
  if (keys.length === 0) return {};
  return ctx.client.get<Obj>(id, { fields: ["id", ...keys].join(","), only_ids: true });
}

function pick(source: Obj, keys: string[]): Obj {
  return Object.fromEntries(keys.map((k) => [k, source[k]]));
}

/**
 * Reads about_me. Geni omits blank fields, so a missing about_me normally means
 * "empty"; but if a translated About exists in detail_strings, the default one
 * was probably withheld, and writing would overwrite it.
 */
async function currentAbout(ctx: ToolContext, id: string): Promise<string | undefined> {
  const current = await currentValues(ctx, id, ["about_me", "detail_strings"]);
  if (typeof current.about_me === "string") return current.about_me;
  const details = current.detail_strings as Record<string, { about_me?: unknown }> | undefined;
  if (details && Object.values(details).some((d) => typeof d?.about_me === "string" && d.about_me.trim())) {
    throw new Error(
      `${id} has About text Geni did not return as about_me (only in other languages). Not appending, to avoid overwriting it; edit it on geni.com instead.`,
    );
  }
  return undefined;
}

/** Appends a dated note below the existing About text, never replacing it. */
export function appendNote(existing: string | undefined, note: string, date: string, heading?: string): string {
  const label = heading ? `${heading} (${date})` : `Research note (${date})`;
  const block = `${label}:\n${note.trim()}`;
  const base = (existing ?? "").trimEnd();
  return base ? `${base}\n\n${block}` : block;
}

export const profileWriteTools = [
  tool({
    name: "update_profile",
    title: "Update a profile",
    description:
      "Changes fields on an existing profile: names, gender, living status, birth/baptism/death/burial " +
      "events, occupation, cause of death, visibility. Only the fields you pass change. Use dry_run first " +
      "to show the user before → after. To add to the About text, use append_about_note instead of about_me.",
    write: "safe",
    input: {
      profile_id: ProfileIdParam,
      ...PersonFields,
      occupation: z.string().optional(),
      cause_of_death: z.string().optional(),
      public: z.boolean().optional(),
      ...DryRun,
    },
    handler: async ({ profile_id, dry_run, ...fields }, ctx) => {
      const id = profileId(profile_id);
      const form = toForm(fields);
      const keys = Object.keys(form);
      if (keys.length === 0) throw new Error("No fields to change were given.");
      const before = pick(await currentValues(ctx, id, keys), keys);
      if (dry_run) return { dry_run: true, profile: id, before, after: form };
      const response = await auditedWrite(ctx, { tool: "update_profile", target: id, request: form, before }, () =>
        ctx.client.post(`${id}/update`, form),
      );
      return { profile: id, before, after: form, response };
    },
  }),

  tool({
    name: "append_about_note",
    title: "Append a research note to About",
    description:
      "Adds a dated note to the end of a profile's About text. Existing text is kept exactly as it is.",
    write: "safe",
    input: {
      profile_id: ProfileIdParam,
      note: z.string().min(1).describe("Note text; cite the source"),
      heading: z.string().optional().describe("Label before the date, default 'Research note'"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, default today"),
      ...DryRun,
    },
    handler: async ({ profile_id, note, heading, date, dry_run }, ctx) => {
      const id = profileId(profile_id);
      const before = await currentAbout(ctx, id);
      const after = appendNote(before, note, date ?? new Date().toISOString().slice(0, 10), heading);
      if (dry_run) return { dry_run: true, profile: id, appended: after.slice((before ?? "").trimEnd().length).trimStart() };
      // Geni only lets us replace about_me, so re-read it just before writing to avoid losing a concurrent edit.
      if ((await currentAbout(ctx, id)) !== before) {
        throw new Error("The About text changed while preparing the note. Run append_about_note again.");
      }
      await auditedWrite(ctx, { tool: "append_about_note", target: id, request: { about_me: after }, before: { about_me: before } }, () =>
        ctx.client.post(`${id}/update`, { about_me: after }),
      );
      return { profile: id, appended: note, about_me_length: after.length };
    },
  }),

  tool({
    name: "create_profile",
    title: "Create an unconnected profile",
    description:
      "Creates a profile that is NOT connected to anyone (Geni's profile/add starts a new, separate tree). " +
      "To add a relative of an existing person, use add_relative.",
    write: "full",
    destructive: true,
    input: { ...PersonFields, ...Confirm },
    handler: async ({ confirm, ...fields }, ctx) => {
      assertConfirmed(confirm, "create_profile", "create a new unconnected profile on Geni");
      const form = toForm(fields);
      return auditedWrite(ctx, { tool: "create_profile", target: "profile/add", request: form }, () =>
        ctx.client.post("profile/add", form),
      );
    },
  }),

  tool({
    name: "add_relative",
    title: "Add a relative",
    description:
      "Creates a new profile and connects it to an existing person as parent, child, partner or sibling. " +
      "Search first: if the relative already exists on Geni, adding them again makes a duplicate.",
    write: "full",
    destructive: true,
    input: {
      profile_id: ProfileIdParam.describe("The existing person to attach the new relative to"),
      relation: z.enum(["parent", "child", "partner", "sibling"]),
      ...PersonFields,
      marriage: EventSchema.optional().describe("relation: partner only"),
      divorce: EventSchema.optional().describe("relation: partner only"),
      relationship_modifier: z.enum(["adopt", "foster"]).optional().describe("relation: child or sibling only"),
      ...Confirm,
    },
    handler: async ({ profile_id, relation, confirm, ...fields }, ctx) => {
      const id = profileId(profile_id);
      assertConfirmed(confirm, "add_relative", `add a new ${relation} to ${id}`);
      const form = toForm(fields);
      return auditedWrite(ctx, { tool: "add_relative", target: id, request: { relation, ...form } }, () =>
        ctx.client.post(`${id}/add-${relation}`, form),
      );
    },
  }),

  tool({
    name: "merge_profiles",
    title: "Merge two profiles",
    description:
      "Merges two profiles of the same person. If you cannot edit both, Geni creates a merge request " +
      "instead. Geni does not document which profile survives. Run compare_profiles first.",
    write: "full",
    destructive: true,
    input: { profile_id: ProfileIdParam, duplicate_profile_id: ProfileIdParam, ...Confirm },
    handler: async ({ profile_id, duplicate_profile_id, confirm }, ctx) => {
      const a = profileId(profile_id);
      const b = profileId(duplicate_profile_id);
      if (a === b) throw new Error("Both ids are the same profile.");
      assertConfirmed(confirm, "merge_profiles", `merge ${a} and ${b} (Geni decides which one survives)`);
      return auditedWrite(ctx, { tool: "merge_profiles", target: `${a}+${b}`, request: {} }, () =>
        ctx.client.post(`${a}/merge/${b}`),
      );
    },
  }),

  tool({
    name: "delete_profile",
    title: "Delete a profile",
    description: "Deletes a profile from Geni. This cannot be undone through the API.",
    write: "full",
    destructive: true,
    input: { profile_id: ProfileIdParam, ...Confirm },
    handler: async ({ profile_id, confirm }, ctx) => {
      const id = profileId(profile_id);
      assertConfirmed(confirm, "delete_profile", `permanently delete ${id}`);
      const before = await ctx.client.get(id, { fields: "id,guid,name,birth,death,profile_url", only_ids: true });
      return auditedWrite(ctx, { tool: "delete_profile", target: id, request: {}, before }, () =>
        ctx.client.post(`${id}/delete`),
      );
    },
  }),

  tool({
    name: "follow_profile",
    title: "Follow or unfollow a profile",
    description: "Follows a profile (get Geni updates about it) or unfollows it.",
    write: "safe",
    input: { profile_id: ProfileIdParam, follow: z.boolean().describe("true to follow, false to unfollow") },
    handler: async ({ profile_id, follow }, ctx) => {
      const id = profileId(profile_id);
      const action = follow ? "follow" : "unfollow";
      return auditedWrite(ctx, { tool: "follow_profile", target: id, request: { action } }, () =>
        ctx.client.post(`${id}/${action}`),
      );
    },
  }),
];
