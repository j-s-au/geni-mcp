// One-shot localhost listener that catches Geni's OAuth redirect, so the user
// does not have to copy the code back by hand.

import { createServer, type Server } from "node:http";

export interface CallbackResult {
  readonly code?: string;
  readonly state?: string;
  readonly error?: string;
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${body}</p></body>`;

/**
 * Starts listening on the redirect URI's host and port. Resolves with the first
 * request that carries a code with the expected state, or Geni's denial
 * (status/message, no code), then closes. Other requests are answered and
 * ignored, so a stray local request cannot end the login. Times out after `timeoutMs`.
 */
export function waitForCallback(
  redirectUri: string,
  timeoutMs: number,
  expectedState?: string,
): { ready: Promise<void>; result: Promise<CallbackResult>; close: () => void } {
  const target = new URL(redirectUri);
  if (target.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(target.hostname)) {
    throw new Error(`Automatic login needs a http://localhost redirect URI, got ${redirectUri}`);
  }

  let server: Server | undefined;
  let timer: NodeJS.Timeout | undefined;
  const close = () => {
    if (timer) clearTimeout(timer);
    server?.close();
  };

  let resolveResult!: (r: CallbackResult) => void;
  const result = new Promise<CallbackResult>((resolve) => {
    resolveResult = resolve;
  });

  const ready = new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", target.origin);
      if (url.pathname !== target.pathname) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code") ?? undefined;
      const state = url.searchParams.get("state") ?? undefined;
      const denial = url.searchParams.get("message") ?? url.searchParams.get("status") ?? undefined;
      const stateOk = expectedState === undefined || state === expectedState;
      if ((code && !stateOk) || (!code && !denial)) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE("Not a valid Geni login", "This request did not come from the current Geni login and was ignored."));
        return;
      }
      const error = code ? undefined : denial;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        code
          ? PAGE("Geni login received", "You can close this tab and return to Claude.")
          : PAGE("Geni login failed", "Geni did not return an authorization code. Return to Claude and try again."),
      );
      close();
      resolveResult({ code, state, error });
    });
    server.once("error", reject);
    server.listen(Number(target.port || 80), target.hostname, () => resolve());
  });

  timer = setTimeout(() => {
    close();
    resolveResult({ error: "timed out waiting for the Geni redirect" });
  }, timeoutMs);
  timer.unref();

  return { ready, result, close };
}
