// Union (couple) tools.

import { z } from "zod";
import { unionId } from "../ids.js";
import { assertConfirmed } from "../safety/write-guard.js";
import { auditedWrite, Confirm, DryRun, EventSchema, PersonFields, toForm, tool } from "./shared.js";

const UnionIdParam = z.string().describe("Union id, e.g. 'union-12276689' (from get_immediate_family)");

export const unionTools = [
  tool({
    name: "get_union",
    title: "Get unions",
    description: "A couple: partners, children (incl. adopted/foster), status, and marriage/divorce events. Accepts up to 50 ids.",
    input: { union_ids: z.array(UnionIdParam).min(1).max(50) },
    handler: async ({ union_ids }, ctx) => {
      const ids = union_ids.map(unionId);
      if (ids.length === 1) return ctx.client.get(ids[0]!, { only_ids: true });
      return ctx.client.get("union", { ids: ids.map((i) => i.replace(/^union-/, "")).join(","), only_ids: true });
    },
  }),

  tool({
    name: "update_union",
    title: "Update marriage or divorce",
    description: "Sets the marriage and/or divorce event (date, place) of a couple.",
    write: "safe",
    input: { union_id: UnionIdParam, marriage: EventSchema.optional(), divorce: EventSchema.optional(), ...DryRun },
    handler: async ({ union_id, marriage, divorce, dry_run }, ctx) => {
      const id = unionId(union_id);
      const form = toForm({ marriage, divorce });
      if (Object.keys(form).length === 0) throw new Error("Give marriage and/or divorce.");
      const before = await ctx.client.get<Record<string, unknown>>(id, { fields: "id,marriage,divorce,partners", only_ids: true });
      if (dry_run) return { dry_run: true, union: id, before, after: form };
      const response = await auditedWrite(ctx, { tool: "update_union", target: id, request: form, before }, () =>
        ctx.client.post(`${id}/update`, form),
      );
      return { union: id, before, response };
    },
  }),

  tool({
    name: "add_to_union",
    title: "Add a child or partner to a couple",
    description:
      "Creates a new profile as a child of an existing couple, or as a partner in it. Search first to avoid duplicates.",
    write: "full",
    destructive: true,
    input: {
      union_id: UnionIdParam,
      role: z.enum(["child", "partner"]),
      ...PersonFields,
      relationship_modifier: z.enum(["adopt", "foster"]).optional().describe("role: child only"),
      ...Confirm,
    },
    handler: async ({ union_id, role, confirm, names: _names, nicknames: _nicknames, title: _title, ...fields }, ctx) => {
      const id = unionId(union_id);
      assertConfirmed(confirm, "add_to_union", `add a new ${role} to ${id}`);
      // union/add-* does not accept names, nicknames or title.
      const form = toForm(role === "child" ? fields : { ...fields, relationship_modifier: undefined });
      return auditedWrite(ctx, { tool: "add_to_union", target: id, request: { role, ...form } }, () =>
        ctx.client.post(`${id}/add-${role}`, form),
      );
    },
  }),
];
