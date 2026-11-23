// runDeviceAuthorization's loopback redirect (loopback login design §5, §6)
// against a fake server: authorize with loopback → the "browser" comes back to
// the listener → token with requestId + code + PKCE verifier; and each way it
// falls back to a device code.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request, type Server } from "node:http";

import type { ComputerAttachGrantRequest } from "../apiClient";
import type { ComputerApiEvent } from "../lib/events";
import { acceptableApprovalUrl, runDeviceAuthorization, type LoopbackLoginOptions } from "./login";

const GRANT: ComputerAttachGrantRequest = { kind: "computer_attach", machineName: "laptop", hostname: "laptop.local", os: "Linux" };
const SERVER_ID = "11111111-2222-4333-8444-555555555555";
const ATTACH_ANSWER = { kind: "computer_attach", attachToken: "dvat_secret", serverId: SERVER_ID, serverSlug: "alpha" };
const DEVICE_ANSWER = {
  deviceCode: "dvc_test",
  userCode: "ABCD-1234",
  verificationUri: "/login/device",
  expiresIn: 30,
  interval: 1,
};

interface FakeServer {
  baseUrl: string;
  authorizeBodies: Array<Record<string, any>>;
  tokenBodies: Array<Record<string, any>>;
  close(): Promise<void>;
}

async function startServer(opts: {
  /** Old server: ignores `loopback` and answers with a device code. */
  ignoresLoopback?: boolean;
  /** Refuses `loopback` with this code. */
  refuseLoopback?: string;
  /** The loopback token answer (default: checks the PKCE verifier, then the attach answer). */
  loopbackToken?: { status: number; body: unknown };
} = {}): Promise<FakeServer> {
  const authorizeBodies: Array<Record<string, any>> = [];
  const tokenBodies: Array<Record<string, any>> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/device/authorize") {
        authorizeBodies.push(body);
        if (body.loopback && opts.refuseLoopback) {
          res.statusCode = 400;
          res.end(JSON.stringify({ code: opts.refuseLoopback }));
          return;
        }
        res.statusCode = 201;
        if (body.loopback && !opts.ignoresLoopback) {
          res.end(JSON.stringify({ requestId: "req-1", approvalUrl: "https://app.example/login/device?request=req-1", expiresIn: 600 }));
          return;
        }
        res.end(JSON.stringify(DEVICE_ANSWER));
        return;
      }
      if (req.url === "/api/auth/device/token") {
        tokenBodies.push(body);
        if (body.requestId !== undefined) {
          if (opts.loopbackToken) {
            res.statusCode = opts.loopbackToken.status;
            res.end(JSON.stringify(opts.loopbackToken.body));
            return;
          }
          const challenge = authorizeBodies.find((b) => b.loopback)?.loopback.codeChallenge;
          const ok = body.requestId === "req-1" && body.code === "one-time" &&
            createHash("sha256").update(String(body.codeVerifier)).digest("base64url") === challenge;
          res.statusCode = ok ? 200 : 400;
          res.end(JSON.stringify(ok ? ATTACH_ANSWER : { code: "pkce_mismatch" }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify(ATTACH_ANSWER));
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("no address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    authorizeBodies,
    tokenBodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** The browser coming back to the return URI the CLI sent (state kept as given). */
function browserCallback(returnUri: string, params: Record<string, string>): Promise<number> {
  const url = new URL(returnUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

function returnUriOf(server: FakeServer): string {
  const sent = server.authorizeBodies.find((b) => b.loopback);
  assert.ok(sent, "authorize was sent a loopback field");
  return sent.loopback.returnUri as string;
}

function loopbackOptions(
  server: () => FakeServer,
  onOpen: (returnUri: string) => void | Promise<void>,
  extra: Partial<LoopbackLoginOptions> = {},
): LoopbackLoginOptions {
  return {
    openBrowser: async (url) => {
      assert.equal(url, "https://app.example/login/device?request=req-1");
      setTimeout(() => void onOpen(returnUriOf(server())), 5);
      return true;
    },
    ...extra,
  };
}

const modes = (events: ComputerApiEvent[]) =>
  events.filter((e) => e.kind === "login.mode").map((e) => (e.kind === "login.mode" && e.mode === "device_code" ? `device_code:${e.reason}` : "loopback"));

test("loopback: authorize with return URI + S256 challenge, browser comes back with a code, token redeemed with the verifier", async () => {
  const server = await startServer();
  const events: ComputerApiEvent[] = [];
  try {
    const r = await runDeviceAuthorization(server.baseUrl, GRANT, {
      onEvent: (e) => events.push(e),
      loopback: loopbackOptions(() => server, (uri) => void browserCallback(uri, { code: "one-time" })),
    });
    assert.deepEqual(r, { status: "attach_token", attachToken: "dvat_secret", serverId: SERVER_ID, serverSlug: "alpha" });
    assert.equal(server.authorizeBodies.length, 1);
    const sent = server.authorizeBodies[0]!;
    assert.deepEqual(sent.grant, GRANT);
    assert.equal(sent.loopback.codeChallengeMethod, "S256");
    assert.match(sent.loopback.returnUri, /^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/callback\?state=[A-Za-z0-9_-]{16,128}$/);
    assert.match(sent.loopback.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(server.tokenBodies.length, 1);
    assert.equal(server.tokenBodies[0]!.requestId, "req-1");
    assert.match(server.tokenBodies[0]!.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(server.tokenBodies[0]!.deviceCode, undefined);
    assert.deepEqual(modes(events), ["loopback"]);
    assert.deepEqual(events.map((e) => e.kind), ["login.mode", "login.loopback-waiting", "login.loopback.result"]);
    const result = events.at(-1);
    assert.ok(result?.kind === "login.loopback.result" && result.result === "approved" && result.msToResult >= 0);
    // No device-code prompt, and no secret on any event.
    assert.equal(JSON.stringify(events).includes("one-time"), false);
    assert.equal(JSON.stringify(events).includes("dvat_"), false);
  } finally {
    await server.close();
  }
});

test("loopback: a callback with another state is ignored (state_mismatch event), the valid one completes", async () => {
  const server = await startServer();
  const events: ComputerApiEvent[] = [];
  try {
    const r = await runDeviceAuthorization(server.baseUrl, GRANT, {
      onEvent: (e) => events.push(e),
      loopback: loopbackOptions(() => server, async (uri) => {
        const stray = new URL(uri);
        stray.searchParams.set("state", "x".repeat(32));
        assert.equal(await browserCallback(stray.toString(), { code: "attacker" }), 400);
        await browserCallback(uri, { code: "one-time" });
      }),
    });
    assert.equal(r.status, "attach_token");
    const results = events.filter((e) => e.kind === "login.loopback.result").map((e) => (e.kind === "login.loopback.result" ? e.result : ""));
    assert.deepEqual(results, ["state_mismatch", "approved"]);
  } finally {
    await server.close();
  }
});

test("loopback: denied in the browser stops at once without a token request", async () => {
  const server = await startServer();
  const events: ComputerApiEvent[] = [];
  try {
    const r = await runDeviceAuthorization(server.baseUrl, GRANT, {
      onEvent: (e) => events.push(e),
      loopback: loopbackOptions(() => server, (uri) => void browserCallback(uri, { error: "access_denied" })),
    });
    assert.deepEqual(r, { status: "denied" });
    assert.equal(server.tokenBodies.length, 0);
    const result = events.at(-1);
    assert.ok(result?.kind === "login.loopback.result" && result.result === "denied");
  } finally {
    await server.close();
  }
});

test("loopback: token errors map as a poll's would (pkce_mismatch, expired_token, device_code_consumed)", async () => {
  for (const [answer, expected] of [
    [{ status: 400, body: { code: "pkce_mismatch" } }, { status: "error", code: "pkce_mismatch" }],
    [{ status: 400, body: { code: "code_invalid" } }, { status: "error", code: "code_invalid" }],
    [{ status: 410, body: { code: "expired_token" } }, { status: "expired" }],
    [{ status: 410, body: { code: "device_code_consumed" } }, { status: "error", code: "device_code_consumed" }],
    [{ status: 403, body: { code: "access_denied" } }, { status: "denied" }],
  ] as const) {
    const server = await startServer({ loopbackToken: answer });
    try {
      const r = await runDeviceAuthorization(server.baseUrl, GRANT, {
        loopback: loopbackOptions(() => server, (uri) => void browserCallback(uri, { code: "one-time" })),
      });
      assert.deepEqual(r, expected);
    } finally {
      await server.close();
    }
  }
});

test("old server: no approvalUrl → the device-code request it already started is polled (one authorize only)", async () => {
  const server = await startServer({ ignoresLoopback: true });
  const events: ComputerApiEvent[] = [];
  let opened = 0;
  try {
    const r = await runDeviceAuthorization(server.baseUrl, GRANT, {
      onEvent: (e) => events.push(e),
      loopback: { openBrowser: async () => (opened += 1, true) },
    });
    assert.equal(r.status, "attach_token");
    assert.equal(server.authorizeBodies.length, 1);
    // The device code was the loopback request itself: nothing more is posted.
    assert.equal(server.authorizeBodies[0]!.loginFallbackReason, undefined);
    assert.equal(opened, 0);
    assert.deepEqual(modes(events), ["device_code:server_unsupported"]);
    const prompt = events.find((e) => e.kind === "login.device-code");
    assert.ok(prompt?.kind === "login.device-code" && prompt.userCode === "ABCD-1234");
    assert.deepEqual(server.tokenBodies, [{ deviceCode: "dvc_test" }]);
  } finally {
    await server.close();
  }
});

test("a server that refuses the loopback field → a fresh device-code request", async () => {
  const server = await startServer({ refuseLoopback: "return_uri_not_allowed" });
  const events: ComputerApiEvent[] = [];
  try {
    const r = await runDeviceAuthorization(server.baseUrl, GRANT, {
      onEvent: (e) => events.push(e),
      loopback: { openBrowser: async () => true },
    });
    assert.equal(r.status, "attach_token");
    assert.equal(server.authorizeBodies.length, 2);
    assert.equal(server.authorizeBodies[1]!.loopback, undefined);
    assert.equal(server.authorizeBodies[0]!.loginFallbackReason, undefined);
    assert.equal(server.authorizeBodies[1]!.loginFallbackReason, "server_unsupported");
    assert.deepEqual(modes(events), ["device_code:server_unsupported"]);
  } finally {
    await server.close();
  }
});

test("pressing c while waiting cancels loopback and starts a fresh device-code request", async () => {
  const server = await startServer();
  const events: ComputerApiEvent[] = [];
  const switchCtl = new AbortController();
  try {
    const r = await runDeviceAuthorization(server.baseUrl, GRANT, {
      onEvent: (e) => {
        events.push(e);
        if (e.kind === "login.loopback-waiting") {
          assert.equal(e.canSwitchToCode, true);
          setTimeout(() => switchCtl.abort(), 5);
        }
      },
      loopback: { openBrowser: async () => true, switchToDeviceCode: switchCtl.signal },
    });
    assert.equal(r.status, "attach_token");
    assert.equal(server.authorizeBodies.length, 2);
    assert.ok(server.authorizeBodies[0]!.loopback);
    assert.equal(server.authorizeBodies[1]!.loopback, undefined);
    assert.deepEqual(server.authorizeBodies[1]!.grant, GRANT);
    assert.equal(server.authorizeBodies[1]!.loginFallbackReason, "user_chose_code");
    assert.deepEqual(modes(events), ["loopback", "device_code:user_chose_code"]);
    assert.ok(events.some((e) => e.kind === "login.device-code"));
    // The loopback request is never redeemed or polled.
    assert.deepEqual(server.tokenBodies, [{ deviceCode: "dvc_test" }]);

    // Asked once in this command: the next approval goes straight to a code.
    const later: ComputerApiEvent[] = [];
    await runDeviceAuthorization(server.baseUrl, GRANT, {
      onEvent: (e) => later.push(e),
      loopback: { openBrowser: async () => assert.fail("no browser"), switchToDeviceCode: switchCtl.signal },
    });
    assert.deepEqual(modes(later), ["device_code:user_chose_code"]);
    assert.equal(server.authorizeBodies.at(-1)!.loopback, undefined);
  } finally {
    await server.close();
  }
});

test("the environment's reason (--device-code, SSH, …) and a missing grant skip loopback entirely", async () => {
  for (const [grant, unavailableReason, expected] of [
    [GRANT, "flag", "device_code:flag"],
    [GRANT, "ssh", "device_code:ssh"],
    [GRANT, "no_display", "device_code:no_display"],
    [GRANT, "wsl", "device_code:wsl"],
    [GRANT, "no_tty", "device_code:no_tty"],
    [undefined, undefined, "device_code:no_grant"],
  ] as const) {
    const server = await startServer();
    const events: ComputerApiEvent[] = [];
    try {
      await runDeviceAuthorization(server.baseUrl, grant, {
        onEvent: (e) => events.push(e),
        loopback: {
          ...(unavailableReason ? { unavailableReason } : {}),
          openBrowser: async () => assert.fail("no browser"),
          startListener: async () => assert.fail("no listener"),
        },
      });
      assert.deepEqual(modes(events), [expected]);
      assert.equal(server.authorizeBodies.length, 1);
      assert.equal(server.authorizeBodies[0]!.loopback, undefined);
      assert.equal(server.authorizeBodies[0]!.loginFallbackReason, expected.slice("device_code:".length));
    } finally {
      await server.close();
    }
  }
});

test("a plain device-code login (no loopback offered) sends no loginFallbackReason", async () => {
  for (const grant of [GRANT, undefined]) {
    const server = await startServer();
    try {
      await runDeviceAuthorization(server.baseUrl, grant, {});
      assert.equal(server.authorizeBodies.length, 1);
      assert.equal("loginFallbackReason" in server.authorizeBodies[0]!, false);
    } finally {
      await server.close();
    }
  }
});

test("bind failure and a browser that cannot be started fall back to a device code", async () => {
  const server = await startServer();
  try {
    const bindEvents: ComputerApiEvent[] = [];
    await runDeviceAuthorization(server.baseUrl, GRANT, {
      onEvent: (e) => bindEvents.push(e),
      loopback: { openBrowser: async () => true, startListener: async () => { throw new Error("EADDRNOTAVAIL"); } },
    });
    assert.deepEqual(modes(bindEvents), ["device_code:bind_failed"]);
    assert.equal(server.authorizeBodies.at(-1)!.loopback, undefined);
    assert.equal(server.authorizeBodies.at(-1)!.loginFallbackReason, "bind_failed");

    const browserEvents: ComputerApiEvent[] = [];
    const before = server.authorizeBodies.length;
    await runDeviceAuthorization(server.baseUrl, GRANT, {
      onEvent: (e) => browserEvents.push(e),
      loopback: { openBrowser: async () => false },
    });
    assert.deepEqual(modes(browserEvents), ["device_code:browser_open_failed"]);
    // The loopback request, then a fresh device-code one.
    assert.equal(server.authorizeBodies.length, before + 2);
    assert.ok(server.authorizeBodies[before]!.loopback);
    assert.equal(server.authorizeBodies[before]!.loginFallbackReason, undefined);
    assert.equal(server.authorizeBodies[before + 1]!.loopback, undefined);
    assert.equal(server.authorizeBodies[before + 1]!.loginFallbackReason, "browser_open_failed");
  } finally {
    await server.close();
  }
});

test("Ctrl-C (the caller's abort) while waiting aborts the login, not a fallback", async () => {
  const server = await startServer();
  const ctl = new AbortController();
  try {
    await assert.rejects(
      () => runDeviceAuthorization(server.baseUrl, GRANT, {
        signal: ctl.signal,
        onEvent: (e) => {
          if (e.kind === "login.loopback-waiting") setTimeout(() => ctl.abort(), 5);
        },
        loopback: { openBrowser: async () => true },
      }),
      (err: Error) => err.name === "AbortError",
    );
    assert.equal(server.authorizeBodies.length, 1);
    assert.equal(server.tokenBodies.length, 0);
  } finally {
    await server.close();
  }
});

test("approval page: only Raft's /login/device over https (http only for a local server) is opened", () => {
  const api = "https://api.raft.build";
  assert.equal(acceptableApprovalUrl("https://app.raft.build/login/device?request=r1", api), "https://app.raft.build/login/device?request=r1");
  assert.equal(acceptableApprovalUrl("/login/device?request=r1", api), "https://api.raft.build/login/device?request=r1");
  assert.equal(acceptableApprovalUrl("http://app.raft.build/login/device?request=r1", api), null);
  assert.equal(acceptableApprovalUrl("https://app.raft.build/somewhere-else", api), null);
  assert.equal(acceptableApprovalUrl("https://user:pw@app.raft.build/login/device", api), null);
  assert.equal(acceptableApprovalUrl("javascript:alert(1)", api), null);
  assert.equal(acceptableApprovalUrl("http://localhost:5173/login/device?request=r1", "http://localhost:3001"), "http://localhost:5173/login/device?request=r1");
  assert.equal(acceptableApprovalUrl("http://evil.example/login/device", "http://localhost:3001"), null);
});
