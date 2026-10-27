// Runtime configuration, read once from environment variables.

import { homedir } from "node:os";
import { join } from "node:path";

export type WriteLevel = "readonly" | "safe" | "full";

export interface Config {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly writeLevel: WriteLevel;
  /** Minimum gap between two API requests, in milliseconds. */
  readonly minIntervalMs: number;
  /** How many times a throttled request is retried before giving up. */
  readonly maxRetries: number;
  readonly configDir: string;
  /** Folders local files may be uploaded from. */
  readonly uploadDirs: readonly string[];
  readonly tokenFile: string;
  readonly auditLogFile: string;
  readonly apiBase: string;
  readonly oauthBase: string;
}

/** Never pace requests faster than this, whatever the environment says. */
const MIN_INTERVAL_FLOOR_MS = 250;

const WRITE_LEVELS: readonly WriteLevel[] = ["readonly", "safe", "full"];

export class ConfigError extends Error {}

function parseNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative number, got "${raw}"`);
  }
  return value;
}

function parseWriteLevel(raw: string | undefined): WriteLevel {
  const value = (raw ?? "safe").trim().toLowerCase();
  if (!WRITE_LEVELS.includes(value as WriteLevel)) {
    throw new ConfigError(`GENI_WRITE_LEVEL must be one of ${WRITE_LEVELS.join(", ")}, got "${raw}"`);
  }
  return value as WriteLevel;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const clientId = env.GENI_CLIENT_ID?.trim();
  const clientSecret = env.GENI_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new ConfigError(
      "GENI_CLIENT_ID and GENI_CLIENT_SECRET are required. Register an app at " +
        "https://www.geni.com/platform/developer/apps and put both in ~/.config/geni-mcp/env",
    );
  }
  const configDir = env.GENI_CONFIG_DIR ?? join(homedir(), ".config", "geni-mcp");

  return {
    clientId,
    clientSecret,
    redirectUri: env.GENI_REDIRECT_URI ?? "http://localhost:3000/oauth/callback",
    writeLevel: parseWriteLevel(env.GENI_WRITE_LEVEL),
    minIntervalMs: Math.max(MIN_INTERVAL_FLOOR_MS, parseNumber("GENI_MIN_INTERVAL_MS", env.GENI_MIN_INTERVAL_MS, 2000)),
    maxRetries: parseNumber("GENI_MAX_RETRIES", env.GENI_MAX_RETRIES, 3),
    configDir,
    uploadDirs: (env.GENI_UPLOAD_DIRS ?? join(homedir(), "Documents"))
      .split(":")
      .map((d) => d.trim())
      .filter(Boolean),
    tokenFile: env.GENI_TOKEN_FILE ?? join(configDir, "tokens.json"),
    auditLogFile: env.GENI_AUDIT_LOG ?? join(configDir, "audit.jsonl"),
    apiBase: env.GENI_API_BASE ?? "https://www.geni.com/api",
    oauthBase: env.GENI_OAUTH_BASE ?? "https://www.geni.com/platform/oauth",
  };
}
