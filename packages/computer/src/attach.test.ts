import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { runAttach, runAttachWithTokenFromStdin } from "./attach";
import { Readable } from "node:stream";
import { deriveDefaultComputerName } from "./paths";
import { CliExit } from "./output";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";
const ATTACH_TOKEN = "dvat_cliAttachToken0123456789";

/**
 * The device-code half of a one-time approval: authorize records the grant's
 * machine name, the poll answers with an attach token for /alpha. Returns
 * true when it answered the request.
 */
async function answerDeviceApproval(
  req: IncomingMessage,
  res: ServerResponse,
  seenGrantNames: string[],
): Promise<boolean> {
  if (req.method === "POST" && req.url === "/api/auth/device/authorize") {
    const body = await readBody(req);
    const grant = body.grant as { machineName?: unknown } | undefined;
    seenGrantNames.push(String(grant?.machineName ?? ""));
    res.writeHead(201, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deviceCode: "dvc_cli", userCode: "ABCD-1234", verificationUri: "https://app.raft.build/login/device", expiresIn: 30, interval: 1 }));
    return true;
  }
  if (req.method === "POST" && req.url === "/api/auth/device/token") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ kind: "computer_attach", attachToken: ATTACH_TOKEN, expiresIn: 600, serverId: SERVER_ID, serverSlug: "alpha", serverName: "Alpha" }));
    return true;
  }
  return false;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function withHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "raft-computer-attach-"));
  const old = process.env.SLOCK_HOME;
  process.env.SLOCK_HOME = home;
  try {
    await mkdir(join(home, "computer"), { recursive: true });
    await writeFile(
      join(home, "computer", "user-session.json"),
      JSON.stringify({
        kind: "user-session",
        userId: "user-1",
        accessToken: "user-token",
        serverUrl: "",
      }),
    );
    return await fn(home);
  } finally {
    if (old === undefined) delete process.env.SLOCK_HOME;
    else process.env.SLOCK_HOME = old;
    await rm(home, { recursive: true, force: true });
  }
}

async function withAttachServer<T>(fn: (baseUrl: string, seenNames: string[], seenAttachAuth: string[]) => Promise<T>): Promise<T> {
  const seenNames: string[] = [];
  const seenAttachAuth: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (await answerDeviceApproval(req, res, seenNames)) return;
      if (req.method === "POST" && req.url === "/api/computer/attach") {
        await readBody(req);
        seenAttachAuth.push(String(req.headers.authorization ?? ""));
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          apiKey: "sk_computer_test",
          serverMachineId: "cm-test",
          serverId: SERVER_ID,
          serverSlug: "alpha",
          resumed: false,
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/internal/computer/preflight") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, serverSlug: "alpha" }));
        return;
      }
      res.writeHead(404).end();
    })().catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await fn(`http://127.0.0.1:${address.port}`, seenNames, seenAttachAuth);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function withServer<T>(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void Promise.resolve(handler(req, res)).catch((err) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

function captureOut(): { restore: () => void; text: () => string } {
  let buf = "";
  const oo = process.stdout.write.bind(process.stdout);
  const oe = process.stderr.write.bind(process.stderr);
  const sink = (chunk: unknown) => {
    buf += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return { restore: () => { process.stdout.write = oo; process.stderr.write = oe; }, text: () => buf };
}

test("attach: default Computer name is derived from hostname", async () => {
  await withHome(async (home) => {
    await withAttachServer(async (baseUrl, seenNames) => {
      const cap = captureOut();
      try {
        await runAttach({ serverSlug: "/alpha", serverUrl: baseUrl, start: false, openUrl: () => {} });
      } finally {
        cap.restore();
      }
      assert.deepEqual(seenNames, [deriveDefaultComputerName()]);
      const attachment = JSON.parse(
        await readFile(join(home, "computer", "servers", SERVER_ID, "runner.state.json"), "utf8"),
      ) as { serverSlug?: string };
      assert.equal(attachment.serverSlug, "alpha");
    });
  });
});

test("attach: approval prompt, dvat_ bearer, and nothing secret printed; the saved user session is left alone", async () => {
  await withHome(async (home) => {
    const sessionBefore = await readFile(join(home, "computer", "user-session.json"), "utf8");
    await withAttachServer(async (baseUrl, _seenNames, seenAttachAuth) => {
      const cap = captureOut();
      const opened: string[] = [];
      try {
        await runAttach({ serverSlug: "/alpha", serverUrl: baseUrl, openUrl: (url) => opened.push(url) });
      } finally {
        cap.restore();
      }
      const out = cap.text();
      assert.deepEqual(opened, ["https://app.raft.build/login/device"]);
      assert.match(out, /To approve this machine, open this link in a browser:\n  https:\/\/app\.raft\.build\/login\/device\n/);
      assert.match(out, /Then enter this code on the page: ABCD-1234\n/);
      assert.match(out, /If the page asks which server, choose \/alpha\.\n/);
      assert.match(out, /Keep this command running — it finishes here automatically once you approve/);
      assert.match(out, /Attached\. Computer state written to /);
      assert.match(out, /Next: run `raft-computer start`/);
      assert.doesNotMatch(out, /dvat_/);
      assert.doesNotMatch(out, /sk_computer_test/);
      assert.deepEqual(seenAttachAuth, [`Bearer ${ATTACH_TOKEN}`]);
      assert.equal(await readFile(join(home, "computer", "user-session.json"), "utf8"), sessionBefore);
    });
  });
});

test("attach (user-session path, setup's legacy branch): unknown slug response is rendered as server-not-found, not disabled surface", async () => {
  await withHome(async () => {
    await withServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/api/computer/attach") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "not_authorized", error: "server not found" }));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const cap = captureOut();
      try {
        await assert.rejects(
          () => runAttach({ serverSlug: "/missing-server", serverUrl: baseUrl, start: false, useUserSession: true }),
          (err) => err instanceof CliExit && err.exitCode === 1,
        );
      } finally {
        cap.restore();
      }
      const out = cap.text();
      assert.match(out, /ATTACH_SERVER_NOT_FOUND/);
      assert.match(out, /Check the slug spelling and --server-url/);
      assert.doesNotMatch(out, /ATTACH_NOT_AUTHORIZED/);
      assert.doesNotMatch(out, /ATTACH_DISABLED/);
      assert.doesNotMatch(out, /fetch failed/);
    });
  });
});

test("attach: request failure is fail-loud and does not bubble raw fetch failed", async () => {
  await withHome(async () => {
    await withServer(async (req, res) => {
      if (await answerDeviceApproval(req, res, [])) return;
      res.socket?.destroy();
    }, async (baseUrl) => {
      const cap = captureOut();
      try {
        await assert.rejects(
          () => runAttach({ serverSlug: "/alpha", serverUrl: baseUrl, start: false, openUrl: () => {} }),
          (err) => err instanceof CliExit && err.exitCode === 1,
        );
      } finally {
        cap.restore();
      }
      const out = cap.text();
      assert.match(out, /ATTACH_REQUEST_FAILED/);
      assert.match(out, /Check --server-url \/ network connectivity/);
      assert.doesNotMatch(out, /fetch failed/);
    });
  });
});

test("attach: name collision renders the complete canonical recovery command", async () => {
  await withHome(async () => {
    await withServer(async (req, res) => {
      if (await answerDeviceApproval(req, res, [])) return;
      if (req.method === "POST" && req.url === "/api/computer/attach") {
        res.writeHead(409, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "COMPUTER_NAME_COLLISION" }));
        return;
      }
      res.writeHead(404).end();
    }, async (baseUrl) => {
      const cap = captureOut();
      try {
        await assert.rejects(
          () => runAttach({ serverSlug: "/alpha", serverUrl: baseUrl, name: "Bench Rig", start: false, openUrl: () => {} }),
          (err) => err instanceof CliExit && err.exitCode === 1,
        );
      } finally {
        cap.restore();
      }
      const out = cap.text();
      assert.match(
        out,
        /What happened \(COMPUTER_NAME_COLLISION\): A Computer named "Bench Rig" already exists on that server\. Run `raft-computer attach \/alpha --name <uniqueName>`\./,
      );
      assert.match(out, /\nNext: raft-computer attach \/alpha --name <uniqueName>\n/);
      assert.doesNotMatch(out, /Re-run with --name <name>/);
    });
  });
});

test("attach: --name override is the machine name the approval page shows", async () => {
  await withHome(async () => {
    await withAttachServer(async (baseUrl, seenNames) => {
      const cap = captureOut();
      try {
        await runAttach({ serverSlug: "/alpha", serverUrl: baseUrl, name: "Bench Rig", start: false, openUrl: () => {} });
      } finally {
        cap.restore();
      }
      assert.deepEqual(seenNames, ["Bench Rig"]);
    });
  });
});

test("attach --attach-token-stdin (Raft Desktop): the token comes from stdin, one JSON line out, nothing secret printed, no approval asked", async () => {
  await withHome(async () => {
    await withAttachServer(async (baseUrl, seenNames, seenAttachAuth) => {
      const cap = captureOut();
      try {
        await runAttachWithTokenFromStdin({
          serverSlug: "alpha",
          serverId: SERVER_ID,
          serverUrl: baseUrl,
          json: true,
          input: Readable.from([`${ATTACH_TOKEN}\n`]),
        });
      } finally {
        cap.restore();
      }
      const out = cap.text();
      assert.deepEqual(seenNames, [], "no device approval: Raft Desktop already ran it");
      assert.deepEqual(seenAttachAuth, [`Bearer ${ATTACH_TOKEN}`]);
      assert.deepEqual(JSON.parse(out.trim()), { serverId: SERVER_ID, serverSlug: "alpha", machineId: null, resumed: false });
      assert.doesNotMatch(out, /dvat_|sk_computer_test/);
    });
  });
});

test("attach --attach-token-stdin without --server-id fails before reading anything and changes nothing", async () => {
  await withHome(async () => {
    const cap = captureOut();
    let threw: unknown = null;
    try {
      await runAttachWithTokenFromStdin({ serverSlug: "alpha", serverUrl: "http://127.0.0.1:9", json: true, input: Readable.from([`${ATTACH_TOKEN}\n`]) });
    } catch (error) {
      threw = error;
    } finally {
      cap.restore();
    }
    assert.ok(threw instanceof CliExit);
    assert.match(cap.text(), /--attach-token-stdin needs --server-id and --server-url/);
    assert.doesNotMatch(cap.text(), /dvat_/);
  });
});
