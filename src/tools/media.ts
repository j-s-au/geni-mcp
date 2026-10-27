// Documents (Geni's sources), photos, videos and photo albums.

import { z } from "zod";
import { normalizeId, profileId, type GeniType } from "../ids.js";
import { assertConfirmed } from "../safety/write-guard.js";
import { readLocalFile } from "./files.js";
import { uploadPolicy } from "./shared.js";
import { auditedWrite, Confirm, DateSchema, DryRun, PageFields, FieldsParam, pageQuery, tool } from "./shared.js";

const MediaKind = z.enum(["document", "photo", "video"]);
type Kind = z.infer<typeof MediaKind>;

const ObjectId = z.string().describe("Object id, e.g. 'document-339953', or just the number");
const FilePath = z.string().describe("Absolute path to a local file inside the upload folders (GENI_UPLOAD_DIRS, default ~/Documents)");

/** Geni wants dates on media writes as a JSON-serialised Date object. */
const jsonDate = (date: z.infer<typeof DateSchema> | undefined) => (date ? JSON.stringify(date) : undefined);

export const mediaTools = [
  tool({
    name: "get_media",
    title: "Get documents, photos, videos or albums",
    description:
      "Fetches documents (Geni's sources and citations), photos, videos or photo albums by id, up to 50 at a time. " +
      "Documents include their title, description, date, labels, source URL, image links and tagged profiles.",
    input: {
      kind: z.enum(["document", "photo", "video", "photo_album"]),
      ids: z.array(ObjectId).min(1).max(50),
      ...FieldsParam,
    },
    handler: async ({ kind, ids, fields }, ctx) => {
      const nodeIds = ids.map((i) => normalizeId(kind as GeniType, i));
      const query = { fields: fields?.join(","), only_ids: true };
      if (nodeIds.length === 1) return ctx.client.get(nodeIds[0]!, query);
      return ctx.client.get(kind, { ...query, ids: nodeIds.map((i) => i.slice(kind.length + 1)).join(",") });
    },
  }),

  tool({
    name: "media_related",
    title: "Comments, tagged profiles, projects or album photos",
    description:
      "Lists what is attached to a document, photo or video: its comments, the profiles tagged in it, or " +
      "(documents only) the projects it belongs to. For a photo_album, lists its photos. Set count: true for just the number.",
    input: {
      kind: z.enum(["document", "photo", "video", "photo_album"]),
      id: ObjectId,
      list: z.enum(["comments", "tags", "projects", "photos"]),
      count: z.boolean().optional(),
      ...PageFields,
      ...FieldsParam,
    },
    handler: async ({ kind, id, list, count, ...rest }, ctx) => {
      const allowed: Record<string, string[]> = {
        document: ["comments", "tags", "projects"],
        photo: ["comments", "tags"],
        video: ["comments", "tags"],
        photo_album: ["photos"],
      };
      if (!allowed[kind]!.includes(list)) {
        throw new Error(`${kind} supports list: ${allowed[kind]!.join(", ")}`);
      }
      return ctx.client.get(`${normalizeId(kind as GeniType, id)}/${list}`, { ...pageQuery(rest), count });
    },
  }),

  tool({
    name: "create_document",
    title: "Create a document (source)",
    description:
      "Adds a document to Geni from a local file (scan, PDF, image), a text transcription, or both with a " +
      "source URL. With profile_id it is created on that profile and tagged to it. Do not upload images " +
      "whose terms forbid redistribution (e.g. FamilySearch images); link with source_url instead.",
    write: "safe",
    input: {
      title: z.string().min(1),
      profile_id: z.string().optional().describe("Tag this profile in the new document"),
      file_path: FilePath.optional(),
      text: z.string().optional().describe("Document body as text (transcription or citation)"),
      source_url: z.string().url().optional(),
      description: z.string().optional(),
      date: DateSchema.optional().describe("Date of the record itself"),
      labels: z.array(z.string()).optional(),
    },
    handler: async ({ title, profile_id, file_path, text, source_url, description, date, labels }, ctx) => {
      if (!file_path && !text && !source_url) throw new Error("Give at least one of file_path, text or source_url.");
      const file = file_path ? await readLocalFile(file_path, uploadPolicy(ctx)) : undefined;
      const form = {
        title,
        text,
        source_url,
        description,
        date: jsonDate(date),
        labels: labels?.join(","),
        file: file?.bytes.toString("base64"),
        file_name: profile_id ? undefined : file?.name,
        content_type: profile_id ? undefined : file?.contentType,
      };
      const path = profile_id ? `${profileId(profile_id)}/add-document` : "document/add";
      const logged = { ...form, file: file ? `<${file.name}, ${file.bytes.length} bytes>` : undefined };
      return auditedWrite(ctx, { tool: "create_document", target: path, request: logged }, () => ctx.client.post(path, form));
    },
  }),

  tool({
    name: "upload_media",
    title: "Upload a photo or video",
    description:
      "Uploads a local photo or video. With profile_id it is added to that profile and tagged; otherwise it " +
      "goes into your uploads (photos can go into an album).",
    write: "safe",
    input: {
      kind: z.enum(["photo", "video"]),
      file_path: FilePath,
      title: z.string().min(1),
      description: z.string().optional(),
      date: DateSchema.optional(),
      profile_id: z.string().optional(),
      album_id: z.string().optional().describe("Photo album id (photos without profile_id only)"),
    },
    handler: async ({ kind, file_path, title, description, date, profile_id, album_id }, ctx) => {
      if (profile_id && album_id) throw new Error("album_id only works without profile_id.");
      const file = await readLocalFile(file_path, uploadPolicy(ctx));
      const logged = { title, description, date, album_id, file: `<${file.name}, ${file.bytes.length} bytes>` };
      if (profile_id) {
        const path = `${profileId(profile_id)}/add-${kind}`;
        const form = { title, description, date: jsonDate(date), file: file.bytes.toString("base64") };
        return auditedWrite(ctx, { tool: "upload_media", target: path, request: logged }, () => ctx.client.post(path, form));
      }
      const body = new FormData();
      body.append("title", title);
      if (description) body.append("description", description);
      if (date) body.append("date", JSON.stringify(date));
      if (album_id && kind === "photo") body.append("album_id", normalizeId("photo_album", album_id).replace(/^photo_album-/, ""));
      body.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), file.name);
      return auditedWrite(ctx, { tool: "upload_media", target: `${kind}/add`, request: logged }, () =>
        ctx.client.request(`${kind}/add`, { method: "POST", multipart: body }),
      );
    },
  }),

  tool({
    name: "set_profile_photo",
    title: "Set a profile's main photo",
    description: "Sets a profile's main photo (mugshot), from a local file or an existing Geni photo.",
    write: "safe",
    input: {
      profile_id: z.string(),
      file_path: FilePath.optional(),
      photo_id: z.string().optional().describe("Existing photo id, instead of file_path"),
      title: z.string().optional(),
      description: z.string().optional(),
      date: DateSchema.optional(),
    },
    handler: async ({ profile_id, file_path, photo_id, title, description, date }, ctx) => {
      if (!file_path === !photo_id) throw new Error("Give exactly one of file_path or photo_id.");
      const id = profileId(profile_id);
      const file = file_path ? await readLocalFile(file_path, uploadPolicy(ctx)) : undefined;
      const form = {
        title,
        description,
        date: jsonDate(date),
        photo_id: photo_id ? normalizeId("photo", photo_id).replace(/^photo-/, "") : undefined,
        file: file?.bytes.toString("base64"),
      };
      const logged = { ...form, file: file ? `<${file.name}>` : undefined };
      return auditedWrite(ctx, { tool: "set_profile_photo", target: id, request: logged }, () =>
        ctx.client.post(`${id}/add-mugshot`, form),
      );
    },
  }),

  tool({
    name: "update_media",
    title: "Update a document, photo or video",
    description:
      "Changes the title, description, date or (documents only) labels of a document, photo or video. " +
      "Videos accept only title and date.",
    write: "safe",
    input: {
      kind: MediaKind,
      id: ObjectId,
      title: z.string().optional(),
      description: z.string().optional(),
      date: DateSchema.optional(),
      labels: z.array(z.string()).optional(),
      ...DryRun,
    },
    handler: async ({ kind, id, title, description, date, labels, dry_run }, ctx) => {
      const nodeId = normalizeId(kind, id);
      if (kind === "video" && description !== undefined) throw new Error("Geni does not allow changing a video's description.");
      if (kind !== "document" && labels !== undefined) throw new Error("Only documents have labels.");
      const form = Object.fromEntries(
        Object.entries({ title, description, date: jsonDate(date), labels: labels?.join(",") }).filter(([, v]) => v !== undefined),
      ) as Record<string, string>;
      if (Object.keys(form).length === 0) throw new Error("No fields to change were given.");
      const before = await ctx.client.get(nodeId, { fields: "id,title,description,date,labels" });
      if (dry_run) return { dry_run: true, target: nodeId, before, after: form };
      return auditedWrite(ctx, { tool: "update_media", target: nodeId, request: form, before }, () =>
        ctx.client.post(`${nodeId}/update`, form),
      );
    },
  }),

  tool({
    name: "tag_media",
    title: "Tag or untag profiles",
    description: "Tags profiles in a document, photo or video (links the source or picture to those people), or removes tags.",
    write: "safe",
    input: {
      kind: MediaKind,
      id: ObjectId,
      profile_ids: z.array(z.string()).min(1).max(25),
      untag: z.boolean().optional().describe("Remove the tags instead of adding them"),
    },
    handler: async ({ kind, id, profile_ids, untag }, ctx) => {
      const nodeId = normalizeId(kind, id);
      const action = untag ? "untag" : "tag";
      const results = [];
      for (const raw of profile_ids) {
        const pid = profileId(raw);
        try {
          await auditedWrite(ctx, { tool: "tag_media", target: nodeId, request: { action, profile: pid } }, () =>
            ctx.client.post(`${nodeId}/${action}/${pid}`),
          );
          results.push({ profile: pid, ok: true });
        } catch (err) {
          results.push({ profile: pid, ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { target: nodeId, action, results };
    },
  }),

  tool({
    name: "add_comment",
    title: "Comment on a document, photo or video",
    description: "Posts a comment on a document, photo or video. Comments are visible to other Geni users.",
    write: "safe",
    input: { kind: MediaKind, id: ObjectId, text: z.string().min(1), title: z.string().optional() },
    handler: async ({ kind, id, text, title }, ctx) => {
      const nodeId = normalizeId(kind, id);
      return auditedWrite(ctx, { tool: "add_comment", target: nodeId, request: { text, title } }, () =>
        ctx.client.post(`${nodeId}/comment`, { text, title }),
      );
    },
  }),

  tool({
    name: "delete_media",
    title: "Delete a document, photo or video",
    description: "Permanently deletes a document, photo or video from Geni.",
    write: "full",
    destructive: true,
    input: { kind: MediaKind, id: ObjectId, ...Confirm },
    handler: async ({ kind, id, confirm }, ctx) => {
      const nodeId = normalizeId(kind as Kind, id);
      assertConfirmed(confirm, "delete_media", `permanently delete ${nodeId}`);
      const before = await ctx.client.get(nodeId, { fields: "id,title,description,tags", only_ids: true });
      return auditedWrite(ctx, { tool: "delete_media", target: nodeId, request: {}, before }, () =>
        ctx.client.post(`${nodeId}/delete`),
      );
    },
  }),

  tool({
    name: "save_album",
    title: "Create or rename a photo album",
    description: "Creates a photo album, or renames one when album_id is given. List your albums with list_mine.",
    write: "safe",
    input: { name: z.string().min(1), album_id: z.string().optional() },
    handler: async ({ name, album_id }, ctx) => {
      const path = album_id ? `${normalizeId("photo_album", album_id)}/update` : "photo_album/add";
      return auditedWrite(ctx, { tool: "save_album", target: path, request: { name } }, () => ctx.client.post(path, { name }));
    },
  }),
];
