// Login, logout and account status tools.

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { waitForCallback } from "../auth/callback-server.js";
import { buildAuthorizationUrl, exchangeCode, extractCode, OAuthError, tokenCheck } from "../auth/oauth.js";
import { TokenStore } from "../auth/token-store.js";
import { tool, type ToolContext } from "./shared.js";

const LOGIN_TIMEOUT_MS = 10 * 60_000;

interface PendingLogin {
  state: string;
  status: "waiting" | "done" | "failed";
  message?: string;
  close?: () => void;
}

let pending: PendingLogin | null = null;

async function finishLogin(ctx: ToolContext, code: string): Promise<void> {
  const tokens = await exchangeCode(ctx.config, code);
  await ctx.client.tokens.save(tokens);
}

export const authTools = [
  tool({
    name: "auth_start",
    title: "Log in to Geni",
    description:
      "Starts the Geni login. Returns a URL for the user to open and approve. A local listener catches " +
      "Geni's redirect and saves the token automatically; check with auth_status. If the listener cannot " +
      "start, the user pastes the redirect URL into auth_complete instead.",
    input: {},
    handler: async (_args, ctx) => {
      pending?.close?.();
      const state = randomBytes(16).toString("hex");
      const url = buildAuthorizationUrl(ctx.config, state);
      const login: PendingLogin = { state, status: "waiting" };
      pending = login;
      try {
        const listener = waitForCallback(ctx.config.redirectUri, LOGIN_TIMEOUT_MS, state);
        login.close = listener.close;
        await listener.ready.catch((err: unknown) => {
          listener.close();
          throw err;
        });
        void listener.result.then(async (result) => {
          if (pending !== login) return;
          try {
            if (!result.code) throw new OAuthError(result.error ?? "no code returned");
            await finishLogin(ctx, result.code);
            login.status = "done";
          } catch (err) {
            login.status = "failed";
            login.message = err instanceof Error ? err.message : String(err);
          }
        });
        return {
          authorization_url: url,
          next_step: "Ask the user to open authorization_url and approve. Then call auth_status.",
          listening_on: ctx.config.redirectUri,
        };
      } catch (err) {
        return {
          authorization_url: url,
          listener_error: err instanceof Error ? err.message : String(err),
          next_step:
            "Ask the user to open authorization_url, approve, then copy the full URL of the page Geni " +
            "redirects to (even if it fails to load) and pass it to auth_complete.",
        };
      }
    },
  }),

  tool({
    name: "auth_complete",
    title: "Finish Geni login manually",
    description: "Finishes login with the code, or the full redirect URL, that Geni sent after the user approved.",
    input: { code_or_url: z.string().min(1).describe("Authorization code or full redirect URL") },
    handler: async ({ code_or_url }, ctx) => {
      const { code, state } = extractCode(code_or_url);
      if (state && pending && state !== pending.state) {
        throw new OAuthError("That redirect belongs to an older login attempt. Run auth_start again.");
      }
      await finishLogin(ctx, code);
      pending?.close?.();
      pending = null;
      return { logged_in: true };
    },
  }),

  tool({
    name: "auth_status",
    title: "Geni login status",
    description:
      "Shows whether the server is logged in to Geni, when the token expires, the rate-limit headers from " +
      "the last call, and the write level. With validate: true it also asks Geni whether the token is valid.",
    input: { validate: z.boolean().optional().describe("Also check the token with Geni (one request)") },
    handler: async ({ validate }, ctx) => {
      const tokens = await ctx.client.tokens.load();
      const result: Record<string, unknown> = {
        logged_in: Boolean(tokens),
        token_expired: tokens ? TokenStore.isExpired(tokens) : undefined,
        expires_at: tokens?.expiresAt ? new Date(tokens.expiresAt).toISOString() : undefined,
        can_refresh: Boolean(tokens?.refreshToken),
        pending_login: pending ? { status: pending.status, message: pending.message } : undefined,
        rate_limit: ctx.client.rateState(),
        write_level: ctx.config.writeLevel,
        min_interval_ms: ctx.config.minIntervalMs,
      };
      if (validate && tokens) result.geni_says = await tokenCheck(ctx.config, "validate_token", tokens.accessToken);
      return result;
    },
  }),

  tool({
    name: "auth_logout",
    title: "Log out of Geni",
    description: "Revokes the access token with Geni and deletes the saved tokens.",
    input: {},
    handler: async (_args, ctx) => {
      const tokens = await ctx.client.tokens.load();
      let revoked: unknown;
      try {
        revoked = tokens ? await tokenCheck(ctx.config, "invalidate_token", tokens.accessToken) : undefined;
      } catch (err) {
        revoked = { error: err instanceof Error ? err.message : String(err) };
      } finally {
        await ctx.client.tokens.clear();
      }
      return { logged_out: true, geni_says: revoked };
    },
  }),

  tool({
    name: "get_user",
    title: "Current Geni user",
    description: "The logged-in user's account (name and account type: basic, plus or pro) and own profile summary.",
    input: {},
    handler: async (_args, ctx) => {
      const user = await ctx.client.get("user");
      const profile = await ctx.client.get("profile", {
        fields: "id,guid,name,gender,profile_url,birth,death,is_alive",
      });
      return { user, profile };
    },
  }),
];

/** Test hook: forget any pending login. */
export function resetPendingLogin(): void {
  pending?.close?.();
  pending = null;
}
