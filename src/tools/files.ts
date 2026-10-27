// Reads local files for upload. Uploads publish to a shared tree, so only known
// media types from the configured upload folders are allowed, never dotfiles
// or this server's own config folder.

import { readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, sep } from "node:path";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
  ".avi": "video/x-msvideo",
};

export interface LocalFile {
  readonly name: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}

export interface UploadPolicy {
  /** Folders uploads may come from. */
  readonly allowedDirs: readonly string[];
  /** Folders that are always refused (the server's config folder). */
  readonly deniedDirs: readonly string[];
}

function isInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveDir(dir: string): Promise<string> {
  try {
    return await realpath(dir);
  } catch {
    return dir;
  }
}

export async function readLocalFile(path: string, policy: UploadPolicy): Promise<LocalFile> {
  if (!isAbsolute(path)) throw new Error(`file_path must be absolute, got ${path}`);
  const contentType = TYPES[extname(path).toLowerCase()];
  if (!contentType) {
    throw new Error(`Only these file types can be uploaded: ${Object.keys(TYPES).join(" ")}`);
  }
  const real = await realpath(path);
  if (real.split(sep).some((part) => part.startsWith("."))) {
    throw new Error(`Refusing to upload from a hidden file or folder: ${real}`);
  }
  for (const denied of policy.deniedDirs) {
    if (isInside(await resolveDir(denied), real)) throw new Error(`Refusing to upload from ${denied}`);
  }
  const allowed = await Promise.all(policy.allowedDirs.map(resolveDir));
  if (!allowed.some((dir) => isInside(dir, real))) {
    throw new Error(`${real} is outside the upload folders (${policy.allowedDirs.join(", ")}). Set GENI_UPLOAD_DIRS to allow more.`);
  }
  const info = await stat(real);
  if (!info.isFile()) throw new Error(`${path} is not a file`);
  if (info.size > MAX_UPLOAD_BYTES) {
    throw new Error(`${path} is ${Math.round(info.size / 1e6)} MB; the limit is ${MAX_UPLOAD_BYTES / 1e6} MB`);
  }
  return { name: basename(real), contentType, bytes: await readFile(real) };
}
