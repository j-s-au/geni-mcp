// Geni OAuth 2.0 (server-side authorization-code flow), per
// https://www.geni.com/platform/developer/help/oauth_server_side

import type { Config } from "../config.js";
import type { StoredTokens } from "./token-store.js";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  error?: string;
  error_description?: string;
}

export class OAuthError extends Error {}

type FetchFn = typeof fetch;

const OAUTH_TIMEOUT_MS = 30_000;

export function buildAuthorizationUrl(config: Config, state: string): string {
  const url = new URL(`${config.oauthBase}/authorize`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  return url.toString();
}

async function requestToken(
  config: Config,
  params: Record<string, string>,
  fetchFn: FetchFn,
  now: number,
): Promise<StoredTokens> {
  // The docs show the token endpoint called with query parameters.
  const url = new URL(`${config.oauthBase}/request_token`);
  const all = {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    ...params,
  };
  for (const [key, value] of Object.entries(all)) url.searchParams.set(key, value);

  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: TokenResponse;
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    throw new OAuthError(`Geni token endpoint returned HTTP ${res.status} with a non-JSON body: ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.error || !body.access_token) {
    const reason = body.error_description ?? body.error ?? `HTTP ${res.status}`;
    throw new OAuthError(`Geni token request failed: ${reason}`);
  }
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : undefined,
  };
}

export function exchangeCode(config: Config, code: string, fetchFn: FetchFn = fetch, now = Date.now()) {
  return requestToken(config, { grant_type: "authorization_code", code }, fetchFn, now);
}

export function refreshTokens(config: Config, refreshToken: string, fetchFn: FetchFn = fetch, now = Date.now()) {
  return requestToken(config, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchFn, now);
}

/**
 * Calls validate_token or invalidate_token and returns the raw JSON reply.
 * These endpoints want the token as the `access_token` query parameter: sent only
 * as a Bearer header, Geni answers 400 invalid_token even for a working token.
 */
export async function tokenCheck(
  config: Config,
  action: "validate_token" | "invalidate_token",
  accessToken: string,
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  const url = new URL(`${config.oauthBase}/${action}`);
  url.searchParams.set("access_token", accessToken);
  const res = await fetchFn(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, body: text.slice(0, 200) };
  }
}

/**
 * Pulls the authorization code out of whatever the user pasted: a bare code,
 * or the full redirect URL (`...?code=XYZ&state=...`).
 */
export function extractCode(input: string): { code: string; state?: string } {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return { code: trimmed };
  const url = new URL(trimmed);
  const params = new URLSearchParams(url.search || url.hash.replace(/^#/, ""));
  const code = params.get("code");
  if (!code) {
    const message = params.get("message") ?? params.get("status");
    throw new OAuthError(message ? `Geni authorization failed: ${message}` : "No code found in that URL.");
  }
  return { code, state: params.get("state") ?? undefined };
}
