import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { runLogin, runLogout, runSessionLogin } from "./login";
import { serverAttachmentPath, userSessionPath } from "./paths";

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-login-"));
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    await rm(home, { recursive: true, force: true });
  }
}

function captureOut(): { restore: () => void; text: () => string } {
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  let buf = "";
  const sink = (c: unknown) => {
    buf += String(c);
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return {
    restore: () => {
      process.stdout.write = oo;
      process.stderr.write = oe;
    },
    text: () => buf,
  };
}

test("login (older server) prints the approval page from the web origin and the code to type, never a pre-filled link, then signs in as before", async () => {
  await withHome(async () => {
    let tokenPolls = 0;
    const server = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/auth/device/authorize") {
          res.statusCode = 201;
          res.end(JSON.stringify({
            deviceCode: "dvc_test",
            userCode: "ABCD-1234",
            verificationUri: "https://slock-app-staging.botiverse.dev/login/device",
            verificationUriComplete: "https://slock-app-staging.botiverse.dev/login/device?user_code=ABCD-1234",
            expiresIn: 30,
            interval: 1,
          }));
          return;
        }
        if (req.url === "/api/auth/device/token") {
          tokenPolls += 1;
          res.statusCode = 200;
          res.end(JSON.stringify({
            accessToken: "access",
            refreshToken: "refresh",
            userId: "user-1",
          }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cap = captureOut();
    const opened: string[] = [];
    try {
      await runLogin({ serverUrl: baseUrl, openUrl: (url) => opened.push(url) });
    } finally {
      cap.restore();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    assert.equal(tokenPolls, 1);
    assert.deepEqual(opened, ["https://slock-app-staging.botiverse.dev/login/device"]);
    assert.match(cap.text(), /https:\/\/slock-app-staging\.botiverse\.dev\/login\/device\n/);
    assert.doesNotMatch(cap.text(), /user_code=/);
    assert.match(cap.text(), /Use `raft-computer attach \/<server>`/);
    assert.match(cap.text(), /opened automatically/);
    assert.match(cap.text(), /Then enter this code on the page: ABCD-1234/);
    // An older server answered with a session: the old login outcome.
    assert.match(cap.text(), /does not support one-time approvals yet/);
    assert.match(cap.text(), /Logged in\. User session written to /);
    // Device approval is user-scoped: never point at a server-scoped surface.
    assert.doesNotMatch(cap.text(), /Connect Computer dialog/);
    assert.doesNotMatch(cap.text(), new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/login/device`));
  });
});

test("runLogin: failed browser auto-open keeps manual authorization URL visible", async () => {
  await withHome(async () => {
    const server = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/auth/device/authorize") {
          res.statusCode = 201;
          res.end(JSON.stringify({
            deviceCode: "dvc_test",
            userCode: "ABCD-1234",
            verificationUri: "https://app.raft.build/login/device",
            verificationUriComplete: "https://app.raft.build/login/device?user_code=ABCD-1234",
            expiresIn: 30,
            interval: 1,
          }));
          return;
        }
        if (req.url === "/api/auth/device/token") {
          res.statusCode = 200;
          res.end(JSON.stringify({
            accessToken: "access",
            refreshToken: "refresh",
            userId: "user-1",
          }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cap = captureOut();
    try {
      await runLogin({
        serverUrl: baseUrl,
        openUrl: () => {
          throw new Error("browser opener unavailable");
        },
      });
    } finally {
      cap.restore();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    assert.match(cap.text(), /https:\/\/app\.raft\.build\/login\/device\n/);
    assert.match(cap.text(), /Then enter this code on the page: ABCD-1234/);
    assert.doesNotMatch(cap.text(), /Connect Computer dialog/);
  });
});

test("runSessionLogin (setup's legacy branch): orchestrated approved event suppresses session path and Next hint", async () => {
  await withHome(async () => {
    let tokenPolls = 0;
    const server = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/api/auth/device/authorize") {
          res.statusCode = 201;
          res.end(JSON.stringify({
            deviceCode: "dvc_test",
            userCode: "ABCD-1234",
            verificationUri: "https://app.raft.build/login/device",
            verificationUriComplete: "https://app.raft.build/login/device?user_code=ABCD-1234",
            expiresIn: 30,
            interval: 1,
          }));
          return;
        }
        if (req.url === "/api/auth/device/token") {
          tokenPolls += 1;
          res.statusCode = 200;
          res.end(JSON.stringify({
            accessToken: "access",
            refreshToken: "refresh",
            userId: "user-1",
          }));
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cap = captureOut();
    try {
      await runSessionLogin({ serverUrl: baseUrl, orchestrated: true, openUrl: () => {} });
    } finally {
      cap.restore();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }

    assert.equal(tokenPolls, 1);
    assert.match(cap.text(), /Keep this command running — sign-in completes here automatically/);
    assert.doesNotMatch(cap.text(), /Logged in\. User session written to/);
    assert.doesNotMatch(cap.text(), /Next: run `raft-computer attach/);
  });
});

// --- v8.3.3 PR-2c Slice 3: DEVICE_AUTHORIZE_FAILED friendlier message ---
//
// Field motivation: raw transport errors (`fetch failed`, `ECONNREFUSED`)
// surfaced to users with no diagnostic context. Slice 3 wraps the
// underlying error with server URL + reachability hint while preserving
// the error code (DEVICE_AUTHORIZE_FAILED stays stable for callers/tests)
// and the raw reason as a substring (operator-side diagnosis still works).

// --- logout (clears the user session only; never per-server attachments) ---

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

test("runLogout: changes nothing — the user session file and per-server attachments stay — and says why", async () => {
  await withHome(async (home) => {
    const sessionPath = userSessionPath(home);
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, JSON.stringify({ kind: "user-session", userId: "u1", accessToken: "t" }));

    const attachPath = serverAttachmentPath(home, "11111111-1111-4111-8111-111111111111");
    await mkdir(dirname(attachPath), { recursive: true });
    await writeFile(attachPath, JSON.stringify({ kind: "computer-attachment" }));

    const cap = captureOut();
    try {
      await runLogout();
    } finally {
      cap.restore();
    }
    assert.equal(await fileExists(sessionPath), true, "logout no longer deletes anything");
    assert.equal(await fileExists(attachPath), true, "per-server attachment must be untouched");
    assert.equal(
      cap.text(),
      "Nothing to log out of: this machine joins each server with a one-time approval and keeps no sign-in. Nothing was changed, and every connected server stays connected.\n" +
        "To take this machine off a server, run `raft-computer detach /<server>`.\n",
    );
  });
});

test("runLogin (current server): runs attach's approval for the server picked on the page, writes no user session", async () => {
  await withHome(async (home) => {
    const authorizeBodies: Array<Record<string, unknown>> = [];
    const attachAuth: string[] = [];
    const server = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(Buffer.from(c)));
        req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          res.setHeader("content-type", "application/json");
          if (req.url === "/api/auth/device/authorize") {
            authorizeBodies.push(body);
            res.statusCode = 201;
            res.end(JSON.stringify({ deviceCode: "dvc_test", userCode: "ABCD-1234", verificationUri: "https://app.raft.build/login/device", expiresIn: 30, interval: 1 }));
            return;
          }
          if (req.url === "/api/auth/device/token") {
            res.statusCode = 200;
            res.end(JSON.stringify({ kind: "computer_attach", attachToken: "dvat_loginAttachToken0123", expiresIn: 600, serverId: "11111111-1111-4111-8111-111111111111", serverSlug: "alpha", serverName: "Alpha" }));
            return;
          }
          if (req.url === "/api/computer/attach") {
            attachAuth.push(String(req.headers.authorization ?? ""));
            res.statusCode = 201;
            res.end(JSON.stringify({ apiKey: "sk_computer_login", serverMachineId: "cm-login", serverId: "11111111-1111-4111-8111-111111111111", serverSlug: "alpha", resumed: false }));
            return;
          }
          if (req.url === "/internal/computer/preflight") {
            res.statusCode = 200;
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.statusCode = 404;
          res.end("{}");
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const cap = captureOut();
    try {
      await runLogin({ serverUrl: baseUrl, openUrl: () => {} });
    } finally {
      cap.restore();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    const out = cap.text();
    assert.match(out, /^Note: `raft-computer login` is no longer a separate step\. Use `raft-computer attach \/<server>`/);
    assert.match(out, /Then enter this code on the page: ABCD-1234/);
    assert.doesNotMatch(out, /If the page asks which server/);
    assert.match(out, /Attached\. Computer state written to /);
    assert.match(out, /Next: run `raft-computer start`/);
    assert.doesNotMatch(out, /dvat_/);
    assert.equal((authorizeBodies[0]!.grant as Record<string, unknown>).kind, "computer_attach");
    assert.deepEqual(attachAuth, ["Bearer dvat_loginAttachToken0123"]);
    assert.equal(await fileExists(userSessionPath(home)), false);
    const saved = JSON.parse(await readFile(serverAttachmentPath(home, "11111111-1111-4111-8111-111111111111"), "utf8")) as { apiKey?: string };
    assert.equal(saved.apiKey, "sk_computer_login");
  });
});

test("runLogin: DEVICE_AUTHORIZE_FAILED preserves underlying transport reason as substring (operator diagnosis)", async () => {
  await withHome(async () => {
    const baseUrl = "http://127.0.0.1:1";
    const cap = captureOut();
    try {
      await assert.rejects(() => runLogin({ serverUrl: baseUrl }));
    } finally {
      cap.restore();
    }
    const out = cap.text();
    // Default stderr is the human error contract; assert the underlying
    // transport reason (ECONNREFUSED / fetch failed / network error) is
    // preserved in the "What happened" line.
    assert.match(out, /What happened \(DEVICE_AUTHORIZE_FAILED\):/);
    // The transport reason appears between the URL prefix and the hint suffix.
    assert.match(out, /Could not start device login at http:\/\/127\.0\.0\.1:1: .+\. Check that the server URL/);
    assert.match(out, /\nNext: raft-computer doctor\n/);
    assert.match(out, /\nState: No local Computer state change was confirmed by this command\.\n/);
    assert.match(out, /\nHelp: https:\/\/app\.raft\.build\/s\/community\/\n/);
  });
});
