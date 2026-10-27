// Tool definition type, shared schemas and helpers used by every tool module.

import { dirname } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type { GeniClient } from "../http/geni-client.js";
import type { AuditLog } from "../safety/audit-log.js";
import type { WriteTier } from "../safety/write-guard.js";
import type { FormValue } from "../http/form.js";
import type { UploadPolicy } from "./files.js";

export interface ToolContext {
  readonly client: GeniClient;
  readonly config: Config;
  readonly audit: AuditLog;
  /** Aborted when the MCP client cancels the call. */
  readonly signal?: AbortSignal;
}

export function uploadPolicy(ctx: ToolContext): UploadPolicy {
  const { configDir, tokenFile, auditLogFile, uploadDirs } = ctx.config;
  return { allowedDirs: uploadDirs, deniedDirs: [configDir, dirname(tokenFile), dirname(auditLogFile)] };
}

/** Throws if the MCP client has cancelled this call. */
export function checkCancelled(ctx: ToolContext): void {
  if (ctx.signal?.aborted) throw new Error("Cancelled.");
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: S;
  /** Omitted for read-only tools. */
  readonly write?: WriteTier;
  readonly destructive?: boolean;
  readonly handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

export function tool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

// ── Shared Geni data shapes ────────────────────────────────────────────────

export const DateSchema = z
  .object({
    year: z.number().int().optional(),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
    circa: z.boolean().optional().describe("The date is approximate"),
    range: z.enum(["before", "after", "between"]).optional(),
    end_year: z.number().int().optional().describe("Only with range: between"),
    end_month: z.number().int().min(1).max(12).optional(),
    end_day: z.number().int().min(1).max(31).optional(),
    end_circa: z.boolean().optional(),
  })
  .describe("Geni date. Give only the parts that are known.");

export const LocationSchema = z.object({
  place_name: z.string().optional().describe("Full place name, e.g. 'Graaff-Reinet, Cape Colony'"),
  city: z.string().optional(),
  county: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  street_address1: z.string().optional(),
  street_address2: z.string().optional(),
  street_address3: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

export const EventSchema = z.object({
  date: DateSchema.optional(),
  location: LocationSchema.optional(),
  name: z.string().optional(),
  description: z.string().optional(),
});

export const NamesSchema = z
  .record(
    z.string(),
    z.object({
      first_name: z.string().optional(),
      middle_name: z.string().optional(),
      last_name: z.string().optional(),
      maiden_name: z.string().optional(),
      suffix: z.string().optional(),
      display_name: z.string().optional(),
      title: z.string().optional(),
    }),
  )
  .describe("Names per locale, e.g. {\"af\": {\"first_name\": \"Jan\"}}. Locale codes: en-US, af, nl, de, ...");

export const PersonFields = {
  first_name: z.string().optional(),
  middle_name: z.string().optional(),
  last_name: z.string().optional(),
  maiden_name: z.string().optional().describe("Birth surname"),
  suffix: z.string().optional(),
  title: z.string().optional().describe("Name title, e.g. 'Ds.' or 'Dr.'"),
  display_name: z.string().optional(),
  names: NamesSchema.optional(),
  nicknames: z.array(z.string()).optional().describe("Also known as"),
  gender: z.enum(["male", "female", "unknown"]).optional(),
  is_alive: z.boolean().optional(),
  birth: EventSchema.optional(),
  baptism: EventSchema.optional(),
  death: EventSchema.optional(),
  burial: EventSchema.optional(),
  about_me: z.string().optional().describe("Replaces the whole About text. To add to it, use append_about_note."),
};

export const PageFields = {
  page: z.number().int().min(1).optional().describe("1-based page number"),
  per_page: z.number().int().min(1).max(50).optional().describe("Results per page (max 50)"),
};

export const FieldsParam = {
  fields: z
    .array(z.string())
    .optional()
    .describe("Only return these fields. about_me, detail_strings and events are only returned when listed here."),
};

/** Converts tool args to a Geni form body: drops undefined, joins nicknames. */
export function toForm(args: Record<string, unknown>): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    out[k] = k === "nicknames" && Array.isArray(v) ? v.join(",") : (v as FormValue);
  }
  return out;
}

export function pageQuery(args: { page?: number; per_page?: number; fields?: string[] }) {
  return { page: args.page, per_page: args.per_page, fields: args.fields?.join(",") };
}

/** Runs a write, records it in the audit log, and returns Geni's response. */
export async function auditedWrite<T>(
  ctx: ToolContext,
  entry: { tool: string; target: string; request: unknown; before?: unknown },
  run: () => Promise<T>,
): Promise<T> {
  try {
    const response = await run();
    await ctx.audit.record({ ...entry, outcome: "ok", response });
    return response;
  } catch (err) {
    await ctx.audit.record({ ...entry, outcome: "error", error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export const DryRun = {
  dry_run: z.boolean().optional().describe("Preview the change without sending it to Geni"),
};

export const Confirm = {
  confirm: z.boolean().optional().describe("Must be true. Set it only after the user approved this exact change."),
};
