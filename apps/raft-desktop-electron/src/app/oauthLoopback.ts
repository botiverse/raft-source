// Desktop OAuth loopback (main process).
//
// The native half of the desktop social-login flow (contract owned by the
// server: PKCE + one-time handoff code; tokens are only ever returned by the
// HTTPS /complete call, never through the browser). This module owns just the
// loopback:
//   - listen on 127.0.0.1:<dynamic>/auth/done
//   - GET serves a tiny handoff page whose JS reads the handoff `code` (query)
//     and the desktop `state` (URL fragment — the server never sees it) and
//     POSTs them back here
//   - POST validates state === the armed nonce, then resolves the `code`
//
// One attempt at a time: arming a new attempt synchronously supersedes the
// previous one (rejecting its code, and its arm promise if it hadn't started
// listening yet). Each server's request handler and timeout operate ONLY on
// their own closed-over attempt — never shared mutable state — so overlapping
// arms can't cross-settle. It never touches tokens.

import { createServer } from "node:http";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";

const DONE_PATH = "/auth/done";
const TIMEOUT_MS = 5 * 60 * 1000; // the user has 5 minutes to finish in the browser
const MAX_BODY_BYTES = 8192; // the handoff payload is tiny

// A minimal page: extract code (query) + state (fragment) and POST them back to
// the loopback. Fragment is only readable here in the browser, not by the server
// redirect. No secrets are ever placed in this page.
const HANDOFF_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Raft</title>
<style>body{font-family:system-ui;background:#fffaef;color:#141111;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{border:2px solid #141111;background:#fff;box-shadow:4px 4px 0 #141111;padding:24px 28px;max-width:360px;text-align:center}</style></head>
<body><div class="card"><h3 id="t">Signing you in…</h3><p id="m">You can return to Raft Desktop.</p></div>
<script>
(function(){
  var params=new URLSearchParams(location.search);
  var hash=new URLSearchParams(location.hash.replace(/^#/,""));
  var code=params.get("code");
  var state=hash.get("state");
  fetch(location.pathname,{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({code:code,state:state})})
    .then(function(r){return r.ok?"ok":Promise.reject()})
    .then(function(){document.getElementById("t").textContent="Signed in";document.getElementById("m").textContent="You can close this window and return to Raft Desktop.";})
    .catch(function(){document.getElementById("t").textContent="Sign-in failed";document.getElementById("m").textContent="Please return to Raft Desktop and try again.";});
})();
</script></body></html>`;

// Only these hosts may be handed to shell.openExternal as an authorization URL.
// The value crosses the IPC/renderer trust boundary, so it is validated in the
// main process against known OAuth provider hosts (+ the API hosts, for any
// API-hosted authorize intermediate) — never a bare "is a string" check.
const AUTHORIZATION_HOSTS: ReadonlySet<string> = new Set([
  "accounts.google.com",
  "github.com",
  "appleid.apple.com",
  "api.raft.build",
  "api-aws-staging.botiverse.dev",
]);

export function isAllowedAuthorizationUrl(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return AUTHORIZATION_HOSTS.has(url.hostname);
}

interface Attempt {
  server: Server;
  nonce: string;
  resolveCode: (code: string) => void;
  rejectCode: (err: Error) => void;
  rejectArm: (err: Error) => void;
  armSettled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
}

// The single current attempt (for supersede). Per-request logic never reads
// this — it uses its own closed-over `attempt`.
let current: Attempt | null = null;

function rejectAttempt(attempt: Attempt, reason: string): void {
  if (attempt.settled) return;
  attempt.settled = true;
  if (attempt.timer) {
    clearTimeout(attempt.timer);
    attempt.timer = null;
  }
  // If it never finished arming (superseded before listen), fail the arm too.
  if (!attempt.armSettled) {
    attempt.armSettled = true;
    attempt.rejectArm(new Error(reason));
  }
  attempt.rejectCode(new Error(reason));
  attempt.server.close();
  if (current === attempt) current = null;
}

function resolveAttempt(attempt: Attempt, code: string): void {
  if (attempt.settled) return;
  attempt.settled = true;
  if (attempt.timer) {
    clearTimeout(attempt.timer);
    attempt.timer = null;
  }
  attempt.resolveCode(code);
  // Give the page a beat to render "Signed in" before the socket closes — but
  // only tear down THIS attempt.
  setTimeout(() => {
    attempt.server.close();
    if (current === attempt) current = null;
  }, 250);
}

/**
 * Start the loopback armed with `nonce`. Returns the chosen local port and a
 * promise that resolves with the handoff `code` once the browser completes and
 * posts back a matching state. Arming supersedes any previous attempt.
 */
export function armOAuthLoopback(nonce: string, timeoutMs: number = TIMEOUT_MS): Promise<{ port: number; code: Promise<string> }> {
  // Supersede synchronously, before we create/register the new attempt, so two
  // un-awaited arm() calls can't both see "no current attempt".
  if (current) rejectAttempt(current, "oauth_superseded");

  return new Promise((resolveArm, rejectArm) => {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (err: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const attempt: Attempt = {
      server: undefined as unknown as Server,
      nonce,
      resolveCode,
      rejectCode,
      rejectArm,
      armSettled: false,
      timer: null,
      settled: false,
    };
    // Swallow the code rejection if the caller never awaits it (e.g. superseded
    // before open-await) so it isn't an unhandled rejection.
    code.catch(() => {});

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== DONE_PATH) {
        res.writeHead(404).end();
        return;
      }
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HANDOFF_HTML);
        return;
      }
      if (req.method === "POST") {
        let bytes = 0;
        const chunks: Buffer[] = [];
        let aborted = false;
        req.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BODY_BYTES) {
            aborted = true;
            res.writeHead(413).end();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", () => {
          if (aborted) return;
          // Already settled (duplicate POST after success) — reject, don't
          // re-resolve or change the first code.
          if (attempt.settled) {
            res.writeHead(409).end();
            return;
          }
          let parsed: { code?: unknown; state?: unknown };
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { code?: unknown; state?: unknown };
          } catch {
            res.writeHead(400).end();
            return;
          }
          const gotCode = typeof parsed.code === "string" ? parsed.code : "";
          const gotState = typeof parsed.state === "string" ? parsed.state : "";
          // Validate against THIS attempt's nonce (closure), not shared state.
          if (!gotCode || gotState !== attempt.nonce) {
            res.writeHead(400).end();
            return;
          }
          res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
          resolveAttempt(attempt, gotCode);
        });
        return;
      }
      res.writeHead(405).end();
    });
    attempt.server = server;
    current = attempt; // register synchronously, before listen

    server.on("error", (err) => {
      if (current === attempt) current = null;
      if (!attempt.armSettled) {
        attempt.armSettled = true;
        rejectArm(err);
      }
    });
    // Port 0 → OS picks a free dynamic port on the loopback interface only.
    server.listen(0, "127.0.0.1", () => {
      if (attempt.settled) return; // superseded before we finished listening
      attempt.armSettled = true;
      const port = (server.address() as AddressInfo).port;
      attempt.timer = setTimeout(() => rejectAttempt(attempt, "oauth_loopback_timeout"), timeoutMs);
      resolveArm({ port, code });
    });
  });
}

/** Cancel the current armed loopback (e.g. the renderer aborted the flow). */
export function cancelOAuthLoopback(): void {
  if (current) rejectAttempt(current, "oauth_cancelled");
}
