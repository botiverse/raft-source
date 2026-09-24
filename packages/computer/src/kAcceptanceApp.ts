// kAcceptanceApp — the computer-shaped release the K acceptance harness
// stamps and serves (#wg-k task #2, Track A step 4).
//
// K's `k-harness --adapter` service-tier teeth build REAL releases from this
// source text (the artifact factory substitutes `__K_VERSION__` and
// `__K_BEHAVIOR__`), stage them through a real upgrade transaction, and read
// the successor's evidence through kHostAdapter's OWN probe. So this app
// must speak exactly the surfaces the real Computer service exposes to the
// adapter — the §4 IPC endpoint and the service pidfile — or the acceptance
// proves nothing about the real wiring:
//
//   <SLOCK_HOME>/computer/run/service.sock   (paths.ts serviceSocketPath)
//   <SLOCK_HOME>/computer/run/service.pid    (paths.ts servicePidPath)
//   wire: 4-byte BE length + UTF-8 JSON frames (internal/ipc-codec.ts)
//   handshake: hello -> hello-ack (§4.3); ping -> pong
//   request "machine-attestation" -> { computerVersion, serviceGeneration,
//     servicePid, managedServerIds, managedMachineIdentities,
//     managedSetRevision }
//
// The path shapes and frame layout are mirrored IN PLAIN JS because the
// staged artifact is spawned by bare `node` (shebang) with no loader — it
// cannot import this package. Each mirrored constant names its source of
// truth; drift there is exactly what the acceptance teeth exist to catch.
//
// `__K_BEHAVIOR__` must genuinely bite (the harness's negative controls all
// serve `crash-on-start`): crash-on-start exits 1 before binding anything;
// wrong-version-probe answers 9.9.9 so the binary_at_target predicate reds.
//
// POSIX-only for now (unix socket; the win32 named-pipe variant lands with
// the real-machine testbed).

/** Managed set the app attests — must match the fixture's dep constants. */
export const ACCEPTANCE_MANAGED = {
  managedServerIds: ["srv-a"],
  managedMachineIdentities: { "srv-a": "mid-a" } as Record<string, string>,
  managedSetRevision: "1",
};

export const COMPUTER_ACCEPTANCE_APP_SOURCE = `#!/usr/bin/env node
// K acceptance app — stamped by k-carrier's artifact factory.
// Mirrors the real Computer service surfaces (see kAcceptanceApp.ts).
"use strict";
const VERSION = "__K_VERSION__";
const BEHAVIOR = "__K_BEHAVIOR__";
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = process.env.SLOCK_HOME;
if (!root) { process.stderr.write("SLOCK_HOME not set\\n"); process.exit(2); }

// The behavior knob must bite BEFORE any surface exists: a crash-on-start
// release leaves no socket, so the adapter's probe fails and K rolls back.
if (BEHAVIOR === "crash-on-start") process.exit(1);

// paths.ts: serviceRunDir/servicePidPath/serviceSocketPath
const runDir = path.join(root, "computer", "run");
const sockPath = path.join(runDir, "service.sock");
const pidPath = path.join(runDir, "service.pid");
fs.mkdirSync(runDir, { recursive: true });
try { fs.unlinkSync(sockPath); } catch {}

const generation = crypto.randomUUID(); // fresh per incarnation (startId)
const managed = {
  managedServerIds: ["srv-a"],
  managedMachineIdentities: { "srv-a": "mid-a" },
  managedSetRevision: "1",
};

// internal/ipc-codec.ts: 4-byte BE length prefix + UTF-8 JSON body
function encodeFrame(payload) {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

const server = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  sock.on("error", () => {});
  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) return;
      const n = buf.readUInt32BE(0);
      if (buf.length < 4 + n) return;
      const body = buf.subarray(4, 4 + n);
      buf = buf.subarray(4 + n);
      let frame;
      try { frame = JSON.parse(body.toString("utf8")); } catch { sock.destroy(); return; }
      if (frame.type === "hello") {
        sock.write(encodeFrame({ type: "hello-ack", protocolVersion: 1, serviceVersion: VERSION }));
      } else if (frame.type === "ping") {
        sock.write(encodeFrame({ type: "pong" }));
      } else if (frame.type === "request" && frame.method === "machine-attestation") {
        const reported = BEHAVIOR === "wrong-version-probe" ? "9.9.9" : VERSION;
        sock.write(encodeFrame({
          type: "response",
          id: frame.id,
          result: {
            computerVersion: reported,
            serviceGeneration: generation,
            servicePid: process.pid,
            managedServerIds: managed.managedServerIds,
            managedMachineIdentities: managed.managedMachineIdentities,
            managedSetRevision: managed.managedSetRevision,
          },
        }));
      } else if (frame.type === "request") {
        sock.write(encodeFrame({
          type: "response",
          id: frame.id,
          error: { code: "IPC_MALFORMED_FRAME", message: "acceptance app answers machine-attestation only, got " + String(frame.method) },
        }));
      }
      // unknown frame types are ignored, mirroring the real client/server
    }
  });
});

server.listen(sockPath, () => {
  // pidfile AFTER the socket is live: stopService reads it to SIGTERM us,
  // and a pid that is discoverable before it can answer is a lie.
  fs.writeFileSync(pidPath, String(process.pid) + "\\n");
});

process.on("SIGTERM", () => {
  try { fs.unlinkSync(pidPath); } catch {}
  try { fs.unlinkSync(sockPath); } catch {}
  process.exit(0);
});

// The bound listening server keeps the event loop (and this process) alive
// until SIGTERM — no timer needed.
`;
