// Attach by one-time approval (device-auth design v2 §3.2) against a fake
// server: the grant asked for at authorize, the `dvat_*` attach token sent as
// the bearer, the sk_computer_* stored (0600), never a user session; the
// older-server fallback; and each failure's code.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ComputerServiceError } from "./errors";
import { approveMachine, approvalOsLabel, attachWithApproval, attachWithToken } from "./attachGrant";
import type { ComputerApiEvent } from "../lib/events";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const ATTACH_TOKEN = "dvat_secretAttachToken0123456789";
const SK_COMPUTER = "sk_computer_fromgrant1234567890";

type Reply = { status: number; body: unknown };

interface FakeServerOptions {
  token?: Reply[];
  attach?: Reply;
  preflight?: Reply;
}

interface FakeServer {
  baseUrl: string;
  authorizeBodies: Array<Record<string, unknown>>;
  attachAuth: string[];
  attachBodies: Array<Record<string, unknown>>;
  preflightAuth: string[];
  tokenPolls: () => number;
}

const ATTACH_TOKEN_REPLY: Reply = {
  status: 200,
  body: { kind: "computer_attach", attachToken: ATTACH_TOKEN, expiresIn: 600, serverId: SERVER_ID, serverSlug: "alpha", serverName: "Alpha" },
};

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function withFakeServer<T>(opts: FakeServerOptions, fn: (server: FakeServer) => Promise<T>): Promise<T> {
  const state: FakeServer = {
    baseUrl: "",
    authorizeBodies: [],
    attachAuth: [],
    attachBodies: [],
    preflightAuth: [],
    tokenPolls: () => tokenIdx,
  };
  let tokenIdx = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req);
      const reply = (r: Reply) => {
        res.writeHead(r.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(r.body));
      };
      if (req.url === "/api/auth/device/authorize") {
        state.authorizeBodies.push(body);
        reply({
          status: 201,
          body: { deviceCode: "dvc_test", userCode: "ABCD-1234", verificationUri: "/login/device", expiresIn: 30, interval: 1 },
        });
        return;
      }
      if (req.url === "/api/auth/device/token") {
        const seq = opts.token ?? [ATTACH_TOKEN_REPLY];
        const next = seq[Math.min(tokenIdx, seq.length - 1)]!;
        tokenIdx += 1;
        reply(next);
        return;
      }
      if (req.url === "/api/auth/me") {
        reply({ status: 200, body: { id: "user-1", email: "u@example.io", name: "u", displayName: "U" } });
        return;
      }
      if (req.url === "/api/computer/attach") {
        state.attachAuth.push(String(req.headers.authorization ?? ""));
        state.attachBodies.push(body);
        reply(opts.attach ?? {
          status: 201,
          body: { apiKey: SK_COMPUTER, serverMachineId: "cm-grant", machineId: "machine-grant", serverId: SERVER_ID, serverSlug: "alpha", resumed: false },
        });
        return;
      }
      if (req.url === "/internal/computer/preflight") {
        state.preflightAuth.push(String(req.headers.authorization ?? ""));
        reply(opts.preflight ?? { status: 200, body: { ok: true, serverSlug: "alpha" } });
        return;
      }
      reply({ status: 404, body: {} });
    })().catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    state.baseUrl = `http://127.0.0.1:${address.port}`;
    return await fn(state);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-attach-grant-"));
  try {
    return await fn(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const sessionPath = (home: string) => join(home, "computer", "user-session.json");
const attachmentPath = (home: string) => join(home, "computer", "servers", SERVER_ID, "runner.state.json");

async function writeLocalAttachment(home: string, serverUrl: string): Promise<void> {
  await mkdir(join(home, "computer", "servers", SERVER_ID), { recursive: true });
  await writeFile(
    attachmentPath(home),
    JSON.stringify({
      kind: "computer-attachment",
      serverId: SERVER_ID,
      serverSlug: "alpha",
      serverMachineId: "cm-existing",
      apiKey: "sk_computer_existing1234567890",
      serverUrl,
    }),
  );
}

async function rejectsWith(run: () => Promise<unknown>, code: string): Promise<ComputerServiceError> {
  let thrown: unknown;
  try {
    await run();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof ComputerServiceError, `expected ComputerServiceError ${code}, got ${String(thrown)}`);
  assert.equal(thrown.code, code);
  return thrown;
}

test("attach by approval: asks for a computer_attach grant, sends the dvat_ token as bearer, stores sk_computer (0600), writes no user session", async () => {
  await withHome(async (home) => {
    await withFakeServer({}, async (server) => {
      const events: ComputerApiEvent[] = [];
      const result = await attachWithApproval(
        { serverSlug: "/alpha", serverUrl: server.baseUrl, name: "studio-mac", slockHome: home },
        { onEvent: (event) => events.push(event) },
      );

      assert.equal(server.authorizeBodies.length, 1);
      const authorize = server.authorizeBodies[0]!;
      assert.equal(authorize.clientName, "raft-computer");
      const grant = authorize.grant as Record<string, unknown>;
      assert.equal(grant.kind, "computer_attach");
      assert.equal(grant.machineName, "studio-mac");
      assert.equal(typeof grant.hostname, "string");
      assert.equal(grant.os, approvalOsLabel());

      assert.deepEqual(server.attachAuth, [`Bearer ${ATTACH_TOKEN}`]);
      assert.equal(server.attachBodies[0]!.serverSlug, "alpha");
      assert.deepEqual(server.preflightAuth, [`Bearer ${SK_COMPUTER}`]);

      const saved = JSON.parse(await readFile(attachmentPath(home), "utf8")) as Record<string, unknown>;
      assert.equal(saved.apiKey, SK_COMPUTER);
      assert.equal(saved.serverId, SERVER_ID);
      assert.equal(saved.serverSlug, "alpha");
      assert.equal(saved.serverUrl, server.baseUrl);
      if (process.platform !== "win32") {
        assert.equal((await stat(attachmentPath(home))).mode & 0o777, 0o600);
      }
      assert.equal(await exists(sessionPath(home)), false, "an approval never writes user-session.json");

      assert.equal(result.serverId, SERVER_ID);
      assert.equal(result.resumed, false);
      assert.deepEqual(
        events.map((e) => e.kind),
        ["login.device-code", "login.polling", "attach.attaching", "attach.preflight", "attach.attached"],
      );
      const visible = JSON.stringify({ events, result });
      assert.doesNotMatch(visible, /dvat_/, "the attach token never reaches an event or the result");
      assert.doesNotMatch(visible, /sk_computer_fromgrant/, "the raw key never reaches an event or the result");
    });
  });
});

test("attach by approval: an older server answering with a session falls back to the session attach", async () => {
  await withHome(async (home) => {
    await withFakeServer(
      { token: [{ status: 200, body: { accessToken: "legacy-access", refreshToken: "legacy-refresh", userId: "user-1" } }] },
      async (server) => {
        const events: ComputerApiEvent[] = [];
        await attachWithApproval(
          { serverSlug: "alpha", serverUrl: server.baseUrl, slockHome: home },
          { onEvent: (event) => events.push(event) },
        );
        assert.equal((server.authorizeBodies[0]!.grant as Record<string, unknown>).kind, "computer_attach");
        assert.deepEqual(server.attachAuth, ["Bearer legacy-access"]);
        const session = JSON.parse(await readFile(sessionPath(home), "utf8")) as Record<string, unknown>;
        assert.equal(session.accessToken, "legacy-access");
        assert.equal(session.serverUrl, server.baseUrl);
        assert.ok(events.some((e) => e.kind === "attach.session-fallback"));
        const saved = JSON.parse(await readFile(attachmentPath(home), "utf8")) as Record<string, unknown>;
        assert.equal(saved.apiKey, SK_COMPUTER);
      },
    );
  });
});

test("attach by approval: a grant answer that is malformed is never read as a session", async () => {
  await withHome(async (home) => {
    await withFakeServer(
      // `kind` says grant; no dvat_ token, but a session-looking field.
      { token: [{ status: 200, body: { kind: "computer_attach", attachToken: "not-a-dvat", accessToken: "smuggled", serverId: SERVER_ID, serverSlug: "alpha" } }] },
      async (server) => {
        const err = await rejectsWith(
          () => attachWithApproval({ serverSlug: "alpha", serverUrl: server.baseUrl, slockHome: home }),
          "ATTACH_APPROVAL_FAILED",
        );
        assert.match(err.message, /unexpected_response/);
        assert.equal(server.attachAuth.length, 0);
        assert.equal(await exists(sessionPath(home)), false);
        assert.equal(await exists(attachmentPath(home)), false);
      },
    );
  });
});

test("attach by approval: approval for another server is refused before the token is used", async () => {
  await withHome(async (home) => {
    await withFakeServer(
      { token: [{ status: 200, body: { kind: "computer_attach", attachToken: ATTACH_TOKEN, expiresIn: 600, serverId: SERVER_ID, serverSlug: "beta", serverName: "Beta" } }] },
      async (server) => {
        const err = await rejectsWith(
          () => attachWithApproval({ serverSlug: "/alpha", serverUrl: server.baseUrl, slockHome: home }),
          "ATTACH_APPROVAL_SERVER_MISMATCH",
        );
        assert.match(err.message, /approved for \/beta, not \/alpha/);
        assert.match(err.message, /`raft-computer attach \/alpha`/);
        assert.equal(server.attachAuth.length, 0);
        assert.equal(await exists(attachmentPath(home)), false);
      },
    );
  });
});

test("attach by approval: denied / expired / used codes map to one-line messages with a retry", async () => {
  const cases: Array<[Reply, string, RegExp]> = [
    [{ status: 403, body: { code: "access_denied" } }, "ATTACH_APPROVAL_DENIED", /not approved/],
    [{ status: 410, body: { code: "expired_token" } }, "ATTACH_APPROVAL_EXPIRED", /expired/],
    [{ status: 410, body: { code: "device_code_consumed" } }, "ATTACH_APPROVAL_USED", /already used/],
  ];
  for (const [reply, code, message] of cases) {
    await withHome(async (home) => {
      await withFakeServer({ token: [reply] }, async (server) => {
        const err = await rejectsWith(
          () => attachWithApproval({ serverSlug: "alpha", serverUrl: server.baseUrl, slockHome: home }),
          code,
        );
        assert.match(err.message, message);
        assert.match(err.message, /Nothing was changed\. Run `raft-computer attach \/alpha`/);
        assert.equal(await exists(attachmentPath(home)), false);
        assert.equal(await exists(sessionPath(home)), false);
      });
    });
  }
});

test("attach by approval: attach refusals (token rejected, approver lost the role or membership) map to their codes", async () => {
  const cases: Array<[Reply, string, RegExp]> = [
    [{ status: 410, body: { code: "attach_token_expired" } }, "ATTACH_APPROVAL_REJECTED", /attach_token_expired/],
    [{ status: 410, body: { code: "attach_token_consumed" } }, "ATTACH_APPROVAL_REJECTED", /attach_token_consumed/],
    [{ status: 401, body: { code: "attach_token_invalid" } }, "ATTACH_APPROVAL_REJECTED", /attach_token_invalid/],
    [{ status: 403, body: { code: "requires_admin" } }, "ATTACH_REQUIRES_ADMIN", /admin or owner role/],
    [{ status: 403, body: { code: "not_authorized" } }, "ATTACH_NOT_AUTHORIZED", /can no longer add Computers to \/alpha/],
  ];
  for (const [reply, code, message] of cases) {
    await withHome(async (home) => {
      await withFakeServer({ attach: reply }, async (server) => {
        const err = await rejectsWith(
          () => attachWithApproval({ serverSlug: "alpha", serverUrl: server.baseUrl, slockHome: home }),
          code,
        );
        assert.match(err.message, message);
        assert.match(err.message, /`raft-computer attach \/alpha`/);
        assert.doesNotMatch(err.message, /dvat_/);
        assert.equal(await exists(attachmentPath(home)), false);
      });
    });
  }
});

test("attach by approval: an already-attached server resumes from local state without asking for approval", async () => {
  await withHome(async (home) => {
    await withFakeServer({}, async (server) => {
      await writeLocalAttachment(home, server.baseUrl);
      const result = await attachWithApproval({ serverSlug: "alpha", slockHome: home });
      assert.equal(result.resumed, true);
      assert.equal(result.serverMachineId, "cm-existing");
      assert.equal(server.authorizeBodies.length, 0);
      assert.equal(server.attachAuth.length, 0);
      assert.deepEqual(server.preflightAuth, ["Bearer sk_computer_existing1234567890"]);
    });
  });
});

test("approve machine (no slug): an approval for an already-attached server resumes it and leaves the token unused", async () => {
  await withHome(async (home) => {
    await withFakeServer({}, async (server) => {
      await writeLocalAttachment(home, server.baseUrl);
      const result = await approveMachine({ serverUrl: server.baseUrl, slockHome: home });
      assert.equal(result.outcome, "attached");
      assert.equal(result.outcome === "attached" && result.resumed, true);
      assert.equal(server.authorizeBodies.length, 1);
      assert.equal(server.attachAuth.length, 0, "the token is not spent on a second Computer for the same server");
      const saved = JSON.parse(await readFile(attachmentPath(home), "utf8")) as Record<string, unknown>;
      assert.equal(saved.apiKey, "sk_computer_existing1234567890");
    });
  });
});

test("approve machine (no slug): an older server signs in with a session and attaches nothing", async () => {
  await withHome(async (home) => {
    await withFakeServer(
      { token: [{ status: 200, body: { accessToken: "legacy-access", refreshToken: "legacy-refresh", userId: "user-1" } }] },
      async (server) => {
        const result = await approveMachine({ serverUrl: server.baseUrl, slockHome: home });
        assert.equal(result.outcome, "signed-in");
        assert.equal(await exists(sessionPath(home)), true);
        assert.equal(server.attachAuth.length, 0);
      },
    );
  });
});

test("attach by approval: an answer with both a dvat_ token and a session is read as the grant; no session is written", async () => {
  await withHome(async (home) => {
    await withFakeServer(
      { token: [{ status: 200, body: { ...(ATTACH_TOKEN_REPLY.body as Record<string, unknown>), accessToken: "smuggled", refreshToken: "r", userId: "u" } }] },
      async (server) => {
        await attachWithApproval({ serverSlug: "alpha", serverUrl: server.baseUrl, slockHome: home });
        assert.deepEqual(server.attachAuth, [`Bearer ${ATTACH_TOKEN}`]);
        assert.equal(await exists(sessionPath(home)), false);
      },
    );
  });
});

test("attach by approval: a server id that is not a UUID is refused before the token is used", async () => {
  await withHome(async (home) => {
    await withFakeServer(
      { token: [{ status: 200, body: { ...(ATTACH_TOKEN_REPLY.body as Record<string, unknown>), serverId: "../../escape" } }] },
      async (server) => {
        await rejectsWith(
          () => attachWithApproval({ serverSlug: "alpha", serverUrl: server.baseUrl, slockHome: home }),
          "ATTACH_APPROVAL_FAILED",
        );
        assert.equal(server.attachAuth.length, 0);
      },
    );
  });
});

test("attach by approval: an attach answer for another server id is not written locally", async () => {
  await withHome(async (home) => {
    await withFakeServer(
      {
        attach: {
          status: 201,
          body: { apiKey: SK_COMPUTER, serverMachineId: "cm-x", serverId: "22222222-2222-4222-8222-222222222222", serverSlug: "alpha", resumed: false },
        },
      },
      async (server) => {
        const err = await rejectsWith(
          () => attachWithApproval({ serverSlug: "alpha", serverUrl: server.baseUrl, slockHome: home }),
          "ATTACH_FAILED",
        );
        assert.match(err.message, /server_mismatch/);
        assert.doesNotMatch(err.message, /sk_computer_/);
        assert.equal(await exists(attachmentPath(home)), false);
        assert.equal(await exists(join(home, "computer", "servers", "22222222-2222-4222-8222-222222222222")), false);
      },
    );
  });
});

test("attach by approval: a caller's retry command (setup) is the next step in failures", async () => {
  await withHome(async (home) => {
    await withFakeServer({ token: [{ status: 403, body: { code: "access_denied" } }] }, async (server) => {
      const err = await rejectsWith(
        () => attachWithApproval({ serverSlug: "alpha", serverUrl: server.baseUrl, slockHome: home, retryCommand: "raft-computer setup /alpha" }),
        "ATTACH_APPROVAL_DENIED",
      );
      assert.match(err.message, /Run `raft-computer setup \/alpha` to ask again\./);
    });
  });
});

// Raft Desktop: it runs the device flow itself and hands the dvat_ token over
// in memory (attachWithToken); nothing asks for an approval here.
test("attach with token (Desktop): sends the dvat_ token as bearer, stores sk_computer (0600), writes no user session, never shows the token", async () => {
  await withHome(async (home) => {
    await withFakeServer({}, async (server) => {
      const events: ComputerApiEvent[] = [];
      const result = await attachWithToken(
        { serverSlug: "alpha", serverId: SERVER_ID, serverUrl: server.baseUrl, attachToken: ATTACH_TOKEN, name: "studio-mac", slockHome: home },
        { onEvent: (event) => events.push(event) },
      );
      assert.equal(server.authorizeBodies.length, 0, "no approval is asked for: the caller already has the token");
      assert.equal(server.tokenPolls(), 0);
      assert.deepEqual(server.attachAuth, [`Bearer ${ATTACH_TOKEN}`]);
      assert.equal(server.attachBodies[0]!.serverSlug, "alpha");
      const saved = JSON.parse(await readFile(attachmentPath(home), "utf8")) as Record<string, unknown>;
      assert.equal(saved.apiKey, SK_COMPUTER);
      if (process.platform !== "win32") {
        assert.equal((await stat(attachmentPath(home))).mode & 0o777, 0o600);
      }
      assert.equal(await exists(sessionPath(home)), false, "a token attach never writes user-session.json");
      assert.equal(result.serverId, SERVER_ID);
      const visible = JSON.stringify({ events, result });
      assert.doesNotMatch(visible, /dvat_/);
    });
  });
});

test("attach with token (Desktop): malformed input is refused before any request, and the error never carries the token", async () => {
  await withHome(async (home) => {
    await withFakeServer({}, async (server) => {
      const base = { serverSlug: "alpha", serverId: SERVER_ID, serverUrl: server.baseUrl, attachToken: ATTACH_TOKEN, slockHome: home };
      for (const bad of [
        { ...base, attachToken: "eyJ-session-access-token" },
        { ...base, attachToken: "dvat_" },
        { ...base, serverId: "../../escape" },
        { ...base, serverSlug: "  " },
        { ...base, serverUrl: "" },
      ]) {
        const err = await rejectsWith(() => attachWithToken(bad), "ATTACH_APPROVAL_FAILED");
        assert.doesNotMatch(err.message, /dvat_secret|eyJ-session/);
      }
      assert.equal(server.attachAuth.length, 0);
      assert.equal(await exists(attachmentPath(home)), false);
    });
  });
});

test("attach with token (Desktop): an attach answer for another server id is not written locally", async () => {
  await withHome(async (home) => {
    await withFakeServer(
      { attach: { status: 201, body: { apiKey: SK_COMPUTER, serverMachineId: "cm-x", serverId: "22222222-2222-4222-8222-222222222222", serverSlug: "alpha", resumed: false } } },
      async (server) => {
        const err = await rejectsWith(
          () => attachWithToken({ serverSlug: "alpha", serverId: SERVER_ID, serverUrl: server.baseUrl, attachToken: ATTACH_TOKEN, slockHome: home }),
          "ATTACH_FAILED",
        );
        assert.match(err.message, /server_mismatch/);
        assert.doesNotMatch(err.message, /dvat_|sk_computer_/);
        assert.equal(await exists(attachmentPath(home)), false);
      },
    );
  });
});

test("attach with token (Desktop): a rejected token maps to ATTACH_APPROVAL_REJECTED without echoing it", async () => {
  await withHome(async (home) => {
    await withFakeServer({ attach: { status: 401, body: { code: "attach_token_used" } } }, async (server) => {
      const err = await rejectsWith(
        () => attachWithToken({ serverSlug: "alpha", serverId: SERVER_ID, serverUrl: server.baseUrl, attachToken: ATTACH_TOKEN, slockHome: home }),
        "ATTACH_APPROVAL_REJECTED",
      );
      assert.doesNotMatch(err.message, /dvat_/);
      assert.equal(await exists(attachmentPath(home)), false);
    });
  });
});

test("attach with token (Desktop): an existing attachment for that server is resumed and the token left unused", async () => {
  await withHome(async (home) => {
    await withFakeServer({}, async (server) => {
      await writeLocalAttachment(home, server.baseUrl);
      const result = await attachWithToken({ serverSlug: "alpha", serverId: SERVER_ID, serverUrl: server.baseUrl, attachToken: ATTACH_TOKEN, slockHome: home });
      assert.equal(result.resumed, true);
      assert.equal(server.attachAuth.length, 0);
    });
  });
});
