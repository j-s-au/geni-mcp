// Persists OAuth tokens to a private JSON file so logins survive restarts.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredTokens {
  readonly accessToken: string;
  readonly refreshToken?: string;
  /** Epoch milliseconds; undefined when Geni did not say. */
  readonly expiresAt?: number;
}

/** Refresh this long before the real expiry to avoid racing it. */
const EXPIRY_MARGIN_MS = 60_000;

export class TokenStore {
  private cached: StoredTokens | null | undefined;

  constructor(private readonly file: string) {}

  async load(): Promise<StoredTokens | null> {
    if (this.cached !== undefined) return this.cached;
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8")) as Partial<StoredTokens>;
      this.cached =
        typeof parsed.accessToken === "string" && parsed.accessToken
          ? {
              accessToken: parsed.accessToken,
              refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
              expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : undefined,
            }
          : null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`geni-mcp: could not read token file ${this.file}:`, err);
      }
      this.cached = null;
    }
    return this.cached;
  }

  async save(tokens: StoredTokens): Promise<void> {
    // Keep using new tokens even if the disk write fails: a rotated refresh token is single-use.
    this.cached = tokens;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }

  async clear(): Promise<void> {
    await rm(this.file, { force: true });
    this.cached = null;
  }

  static isExpired(tokens: StoredTokens, now = Date.now()): boolean {
    return tokens.expiresAt !== undefined && now >= tokens.expiresAt - EXPIRY_MARGIN_MS;
  }
}
