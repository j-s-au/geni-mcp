// Decides whether a write tool may run under the configured GENI_WRITE_LEVEL.

import type { WriteLevel } from "../config.js";

/**
 * - "safe": edits that change existing data in place or add sources/media.
 * - "full": changes to tree structure (new people, relationships, merges) and deletions.
 */
export type WriteTier = "safe" | "full";

export class WriteBlockedError extends Error {}

const RANK: Record<WriteLevel, number> = { readonly: 0, safe: 1, full: 2 };
const NEEDED: Record<WriteTier, number> = { safe: 1, full: 2 };

export function assertWriteAllowed(level: WriteLevel, tier: WriteTier, tool: string): void {
  if (RANK[level] >= NEEDED[tier]) return;
  const hint =
    level === "readonly"
      ? "The server is in read-only mode."
      : `This tool changes the tree's structure or deletes data, so it needs GENI_WRITE_LEVEL=full (currently "${level}").`;
  throw new WriteBlockedError(`${tool} is not allowed. ${hint} Change it in ~/.config/geni-mcp/env and reconnect the server.`);
}

/** Destructive tools also need an explicit confirm flag on every call. */
export function assertConfirmed(confirm: boolean | undefined, tool: string, what: string): void {
  if (confirm !== true) {
    throw new WriteBlockedError(`${tool} will ${what}. Re-run it with confirm: true once the user has approved this exact change.`);
  }
}
