// The loopback redirect's receiving end (RFC 8252; loopback login design §5,
// §7): a one-route HTTP listener on 127.0.0.1 and a random port that the
// approval page sends the browser back to, with the one-time code (or
// `error=access_denied`) and the `state` this Computer put in the return URI.
//
//   - bound to 127.0.0.1 only (never all interfaces, never `localhost`);
//   - one route, `GET /callback`; anything else is a 404, with no CORS
//     headers, so no other page can read an answer from it;
//   - a callback whose `state` is not ours (another tab, an old link, a page
//     guessing ports) is answered 400 and ignored: the listener keeps waiting;
//   - the first valid callback settles it and the listener closes; so do a
//     cancel and the deadline.
//
// The code is handed to the caller only; it is never logged or put on an
// event.
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_CALLBACK_PATH = "/callback";
/** The longest a loopback approval is waited for, whatever the server says. */
export const LOOPBACK_MAX_WAIT_MS = 10 * 60 * 1000;

const MAX_CODE_LENGTH = 512;

export type LoopbackCallback =
  | { status: "code"; code: string }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "cancelled" };

/** Why a request to the listener was answered and then ignored. */
export type LoopbackRejection = "state_mismatch";

export interface LoopbackListener {
  readonly port: number;
  /** `http://127.0.0.1:<port>/callback?state=<state>`: what authorize is sent. */
  readonly returnUri: string;
  /**
   * Settles on the first valid callback, when `signal` aborts (`cancelled`)
   * or after `timeoutMs` (`expired`, capped at LOOPBACK_MAX_WAIT_MS). The
   * listener is closed when it settles. Call once.
   */
  wait(options: { timeoutMs: number; signal?: AbortSignal }): Promise<LoopbackCallback>;
  /** Stop listening and drop open connections (idempotent). */
  close(): Promise<void>;
}

export interface StartLoopbackListenerOptions {
  /** The state put in the return URI; a callback must carry it unchanged. */
  state: string;
  /** Told about each callback that was ignored (never with its values). */
  onRejected?: (why: LoopbackRejection) => void;
}

function sameSecret(expected: string, actual: string | null): boolean {
  if (actual === null) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const PAGE_STYLE =
  "body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fafafa;color:#1a1a1a}" +
  "main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}p{margin:0;color:#555;line-height:1.5}" +
  "@media (prefers-color-scheme:dark){body{background:#141414;color:#eee}p{color:#aaa}}";

function page(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PAGE_STYLE}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
}

const PAGES = {
  approved: page("Raft Computer approved", "You can close this tab and go back to the terminal."),
  denied: page("Raft Computer not approved", "Nothing was changed on this machine. You can close this tab and go back to the terminal."),
  invalid: page("This link is not for this login", "Go back to the terminal: it is still waiting for the approval it started."),
  notFound: page("Not found", "Nothing is here."),
} as const;

function send(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    // The callback URL carries the one-time code: never send it on.
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    Connection: "close",
  });
  res.end(body);
}

/**
 * Listen on 127.0.0.1 on a random port. Rejects when the port cannot be
 * bound (the caller then uses a device code).
 */
export async function startLoopbackListener(options: StartLoopbackListenerOptions): Promise<LoopbackListener> {
  let settle: ((result: LoopbackCallback) => void) | null = null;
  let settled: LoopbackCallback | null = null;
  let port = 0;

  const finish = (result: LoopbackCallback) => {
    if (settled) return;
    settled = result;
    settle?.(result);
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}:${port}`);
    } catch {
      send(res, 400, PAGES.notFound);
      return;
    }
    if (req.method !== "GET" || url.pathname !== LOOPBACK_CALLBACK_PATH) {
      send(res, 404, PAGES.notFound);
      return;
    }
    // A page that resolves its own name to 127.0.0.1 (DNS rebinding) sends
    // its own Host: only our address is answered.
    if (req.headers.host !== `${LOOPBACK_HOST}:${port}`) {
      send(res, 404, PAGES.notFound);
      return;
    }
    if (settled) {
      send(res, 404, PAGES.notFound);
      return;
    }
    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || !sameSecret(options.state, states[0] ?? null)) {
      options.onRejected?.("state_mismatch");
      send(res, 400, PAGES.invalid);
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error === "access_denied" && code === null) {
      send(res, 200, PAGES.denied);
      finish({ status: "denied" });
      return;
    }
    if (error === null && code !== null && code.length > 0 && code.length <= MAX_CODE_LENGTH) {
      send(res, 200, PAGES.approved);
      finish({ status: "code", code });
      return;
    }
    // Our state but no usable answer: not something the server sends.
    send(res, 400, PAGES.invalid);
  };

  const server: Server = createServer(handle);
  // Keep-alive sockets from the browser must not hold the process open.
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address !== "object") {
    server.close();
    throw new Error("loopback listener has no address");
  }
  port = address.port;
  server.unref();

  let closing: Promise<void> | null = null;
  const close = () => {
    closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  };

  return {
    port,
    returnUri: `http://${LOOPBACK_HOST}:${port}${LOOPBACK_CALLBACK_PATH}?state=${options.state}`,
    close,
    wait({ timeoutMs, signal }) {
      return new Promise<LoopbackCallback>((resolve) => {
        const ms = Math.max(0, Math.min(timeoutMs, LOOPBACK_MAX_WAIT_MS));
        const timer = setTimeout(() => finish({ status: "expired" }), ms);
        const onAbort = () => finish({ status: "cancelled" });
        settle = (result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          // Let the answer page go out before the connections are dropped.
          setImmediate(() => void close());
          resolve(result);
        };
        if (settled) {
          settle(settled);
          return;
        }
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}
