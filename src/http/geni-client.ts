// Low-level Geni REST client: auth, token refresh, pacing, retries and errors.

import type { Config } from "../config.js";
import { refreshTokens } from "../auth/oauth.js";
import { TokenStore, type StoredTokens } from "../auth/token-store.js";
import { encodeForm, type FormValue } from "./form.js";
import { RateLimiter, realClock, type Clock, type RateState } from "./rate-limiter.js";

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly query?: Query;
  /** Form-encoded POST body (Rails bracket keys for nested values). */
  readonly form?: Record<string, FormValue>;
  /** Multipart POST body, for photo/add and video/add. */
  readonly multipart?: FormData;
}

export class GeniApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "auth" | "rate_limit" | "blocked" | "not_found" | "api",
  ) {
    super(message);
  }
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not logged in to Geni. Call the auth_start tool, open the URL it returns, and approve access.");
  }
}

type FetchFn = typeof fetch;

/** Abort a request that has not answered in this long. */
export const REQUEST_TIMEOUT_MS = 60_000;
/** After Geni returns a block page, refuse to call it again for this long. */
export const BLOCK_COOLDOWN_MS = 30 * 60_000;
const MAX_BACKOFF_MS = 60_000;

export class GeniClient {
  private refreshing: Promise<StoredTokens> | null = null;
  private blockedUntil = Number.NEGATIVE_INFINITY;
  private blockedMessage = "";
  readonly limiter: RateLimiter;

  constructor(
    private readonly config: Config,
    readonly tokens: TokenStore,
    private readonly fetchFn: FetchFn = fetch,
    private readonly clock: Clock = realClock,
  ) {
    this.limiter = new RateLimiter(config.minIntervalMs, clock);
  }

  rateState(): RateState {
    return this.limiter.snapshot();
  }

  async get<T = unknown>(path: string, query?: Query): Promise<T> {
    return this.request<T>(path, { method: "GET", query });
  }

  async post<T = unknown>(path: string, form?: Record<string, FormValue>, query?: Query): Promise<T> {
    return this.request<T>(path, { method: "POST", form: form ?? {}, query });
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    if (this.clock.now() < this.blockedUntil) {
      const until = new Date(this.blockedUntil).toISOString();
      throw new GeniApiError(`${this.blockedMessage} Not calling Geni again before ${until} (restart the server to override).`, 403, "blocked");
    }
    let tokens = await this.currentTokens();
    let refreshedAfter401 = false;

    for (let attempt = 0; ; attempt++) {
      const res = await this.limiter.schedule(() => this.send(path, options, tokens.accessToken));
      this.limiter.observe(res.headers);
      const text = await res.text();

      if (res.ok) return parseJson<T>(text, res.status);

      const failure = classify(res.status, text);
      if (failure.kind === "blocked") {
        this.blockedUntil = this.clock.now() + BLOCK_COOLDOWN_MS;
        this.blockedMessage = failure.message;
      }
      if (failure.kind === "rate_limit") {
        // Pause the whole queue, not just this call, so other requests stop too.
        this.limiter.pause(backoffMs(res.headers, attempt));
        if (attempt < this.config.maxRetries) continue;
      }
      if (failure.kind === "auth" && !refreshedAfter401 && tokens.refreshToken) {
        refreshedAfter401 = true;
        tokens = await this.refreshAfterFailure(tokens);
        continue;
      }
      throw new GeniApiError(failure.message, res.status, failure.kind);
    }
  }

  private send(path: string, options: RequestOptions, accessToken: string): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    let body: string | FormData | undefined;
    if (options.multipart) {
      body = options.multipart;
    } else if (options.form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = encodeForm(options.form);
    }
    return this.fetchFn(url, {
      method: options.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  buildUrl(path: string, query?: Query): string {
    const clean = path.replace(/^\/+/, "").replace(/^api\//, "");
    const base = new URL(`${this.config.apiBase}/`);
    if (/^[a-z]+:/i.test(clean) || /\.\.|%2e|%2f|\\/i.test(clean)) {
      throw new Error(`Invalid API path: ${path}`);
    }
    const url = new URL(clean, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) {
      throw new Error(`Invalid API path: ${path}`);
    }
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  private async currentTokens(): Promise<StoredTokens> {
    const tokens = await this.tokens.load();
    if (!tokens) throw new NotAuthenticatedError();
    if (!TokenStore.isExpired(tokens, this.clock.now())) return tokens;
    if (!tokens.refreshToken) throw new NotAuthenticatedError();
    return this.refresh(tokens.refreshToken);
  }

  /**
   * After a 401: if another request already refreshed (the stored token differs
   * from the one that failed), use that instead of spending the old refresh token.
   */
  private async refreshAfterFailure(failed: StoredTokens): Promise<StoredTokens> {
    if (this.refreshing) return this.refreshing;
    const stored = await this.tokens.load();
    if (stored && stored.accessToken !== failed.accessToken) return stored;
    return this.refresh(stored?.refreshToken ?? failed.refreshToken!);
  }

  private refresh(refreshToken: string): Promise<StoredTokens> {
    // Coalesce concurrent refreshes onto one HTTP call.
    this.refreshing ??= (async () => {
      try {
        const fresh = await refreshTokens(this.config, refreshToken, this.fetchFn, this.clock.now());
        const merged = { ...fresh, refreshToken: fresh.refreshToken ?? refreshToken };
        await this.tokens.save(merged);
        return merged;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

function parseJson<T>(text: string, status: number): T {
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GeniApiError(`Geni returned HTTP ${status} with a non-JSON body: ${snippet(text)}`, status, "api");
  }
}

function snippet(text: string): string {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Works out what kind of failure a non-2xx response is. The REST error format is undocumented. */
export function classify(status: number, text: string): { kind: GeniApiError["kind"]; message: string } {
  const lower = text.toLowerCase();
  const isHtml = lower.trimStart().startsWith("<");
  if (lower.includes("temporarily blocked") || (isHtml && lower.includes("access denied"))) {
    return {
      kind: "blocked",
      message:
        `Geni refused the request (HTTP ${status}): ${snippet(text)}. ` +
        "This looks like an IP or account block, not a normal error. Stop calling the API and wait.",
    };
  }
  let detail = snippet(text);
  try {
    const body = JSON.parse(text) as { error?: unknown; message?: unknown; error_description?: unknown };
    const err = body.error;
    if (err && typeof err === "object") {
      const e = err as { message?: unknown; type?: unknown };
      detail = [e.type, e.message].filter(Boolean).join(": ") || detail;
    } else {
      detail = [err, body.error_description ?? body.message].filter(Boolean).join(": ") || detail;
    }
  } catch {
    // keep the text snippet
  }
  const message = `Geni API error ${status}: ${detail}`;
  if (status === 429 || lower.includes("rate limit")) return { kind: "rate_limit", message };
  const tokenProblem = lower.includes("invalid_token") || lower.includes("expired");
  if (status === 401 || (status === 403 && tokenProblem)) return { kind: "auth", message };
  if (status === 404) return { kind: "not_found", message };
  return { kind: "api", message };
}

function backoffMs(headers: Headers, attempt: number): number {
  const retryAfter = Number(headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(MAX_BACKOFF_MS, retryAfter * 1000);
  const window = Number(headers.get("x-api-rate-window"));
  if (Number.isFinite(window) && window > 0) return Math.min(MAX_BACKOFF_MS, window * 1000);
  return Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** attempt);
}
