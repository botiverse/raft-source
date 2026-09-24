import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "vitest";

import { runAttach } from "./attach.js";
import { deriveDefaultComputerName } from "./paths.js";
import { CliExit } from "./output.js";

const SERVER_ID = "11111111-1111-4111-8111-111111111111";

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

async function withAttachServer<T>(fn: (baseUrl: string, seenNames: string[]) => Promise<T>): Promise<T> {
  const seenNames: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method === "POST" && req.url === "/api/computer/attach") {
        const body = await readBody(req);
        seenNames.push(String(body.name ?? ""));
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
    return await fn(`http://127.0.0.1:${address.port}`, seenNames);
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
      await runAttach({ serverSlug: "/alpha", serverUrl: baseUrl, start: false });
      assert.deepEqual(seenNames, [deriveDefaultComputerName()]);
      const attachment = JSON.parse(
        await readFile(join(home, "computer", "servers", SERVER_ID, "runner.state.json"), "utf8"),
      ) as { serverSlug?: string };
      assert.equal(attachment.serverSlug, "alpha");
    });
  });
});

test("attach: unknown slug response is rendered as server-not-found, not disabled surface", async () => {
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
          () => runAttach({ serverSlug: "/missing-server", serverUrl: baseUrl, start: false }),
          (err) => err instanceof CliExit && err.exitCode === 1,
        );
      } finally {
        cap.restore();
      }
      const out = cap.text();
      assert.match(out, /ATTACH_SERVER_NOT_FOUND/);
      assert.match(out, /Server \/missing-server was not found/);
      assert.match(out, /Check the slug spelling and --server-url/);
      assert.doesNotMatch(out, /ATTACH_NOT_AUTHORIZED/);
      assert.doesNotMatch(out, /ATTACH_DISABLED/);
      assert.doesNotMatch(out, /fetch failed/);
    });
  });
});

test("attach: request failure is fail-loud and does not bubble raw fetch failed", async () => {
  await withHome(async () => {
    await withServer(async (_req, res) => {
      res.socket?.destroy();
    }, async (baseUrl) => {
      const cap = captureOut();
      try {
        await assert.rejects(
          () => runAttach({ serverSlug: "/alpha", serverUrl: baseUrl, start: false }),
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
          () => runAttach({ serverSlug: "/alpha", serverUrl: baseUrl, name: "Bench Rig", start: false }),
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

test("attach: --name override is sent as the Computer display name", async () => {
  await withHome(async () => {
    await withAttachServer(async (baseUrl, seenNames) => {
      await runAttach({ serverSlug: "/alpha", serverUrl: baseUrl, name: "Bench Rig", start: false });
      assert.deepEqual(seenNames, ["Bench Rig"]);
    });
  });
});
