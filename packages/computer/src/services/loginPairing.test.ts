// runDeviceAuthorization with `--pair` (docs/contracts/computer-pairing.md):
// `pairingId` + `serverSlug` go on a computer grant's device-code authorize
// only (never a loopback one, never without a grant), and the answer's
// `paired` reaches the device-code event without the id.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import type { ComputerAttachGrantRequest } from "../apiClient";
import type { ComputerApiEvent } from "../lib/events";
import { runDeviceAuthorization } from "./login";

const GRANT: ComputerAttachGrantRequest = { kind: "computer_attach", machineName: "box", hostname: "box.local", os: "Linux" };
const PAIRING = { pairingId: "pAiR_0123456789abcdefghijklmnopqrstuvwxyzAB", serverSlug: "alpha" };
const DEVICE_ANSWER = { deviceCode: "dvc_test", userCode: "ABCD-1234", verificationUri: "/login/device", expiresIn: 30, interval: 1 };
const ATTACH_ANSWER = { kind: "computer_attach", attachToken: "dvat_secret", serverId: "11111111-2222-4333-8444-555555555555", serverSlug: "alpha" };

interface FakeServer {
  baseUrl: string;
  authorizeBodies: Array<Record<string, any>>;
  close(): Promise<void>;
}

/** `paired`: what the server answers when a pairingId came (undefined: an older server, which ignores it). */
async function startServer(paired?: boolean): Promise<FakeServer> {
  const authorizeBodies: Array<Record<string, any>> = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/device/authorize") {
        authorizeBodies.push(body);
        res.statusCode = 201;
        if (body.loopback) {
          res.end(JSON.stringify({ requestId: "req-1", approvalUrl: "https://app.example/login/device?request=req-1", expiresIn: 600 }));
          return;
        }
        const linked = body.pairingId !== undefined && paired !== undefined ? { paired } : {};
        res.end(JSON.stringify({ ...linked, ...DEVICE_ANSWER }));
        return;
      }
      if (req.url === "/api/auth/device/token") {
        res.statusCode = 200;
        res.end(JSON.stringify(body.deviceCode ? ATTACH_ANSWER : { accessToken: "a", refreshToken: "r", userId: "u" }));
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function deviceCodeEvent(events: ComputerApiEvent[]): Extract<ComputerApiEvent, { kind: "login.device-code" }> {
  const event = events.find((e) => e.kind === "login.device-code");
  assert.ok(event && event.kind === "login.device-code", "a device code was shown");
  return event;
}

test("pairing: a device-code authorize with a computer grant carries pairingId + serverSlug; paired reaches the event, the id does not", async () => {
  const server = await startServer(true);
  try {
    const events: ComputerApiEvent[] = [];
    const r = await runDeviceAuthorization(server.baseUrl, GRANT, { pairing: PAIRING, onEvent: (e) => events.push(e) });
    assert.equal(r.status, "attach_token");
    assert.equal(server.authorizeBodies.length, 1);
    assert.equal(server.authorizeBodies[0]?.pairingId, PAIRING.pairingId);
    assert.equal(server.authorizeBodies[0]?.serverSlug, "alpha");
    assert.equal(deviceCodeEvent(events).paired, true);
    assert.doesNotMatch(JSON.stringify(events), new RegExp(PAIRING.pairingId));
  } finally {
    await server.close();
  }
});

test("pairing: not linked → paired false; an older server's answer (no field) is also paired false", async () => {
  for (const answer of [false, undefined]) {
    const server = await startServer(answer);
    try {
      const events: ComputerApiEvent[] = [];
      await runDeviceAuthorization(server.baseUrl, GRANT, { pairing: PAIRING, onEvent: (e) => events.push(e) });
      assert.equal(server.authorizeBodies[0]?.pairingId, PAIRING.pairingId);
      assert.equal(deviceCodeEvent(events).paired, false);
    } finally {
      await server.close();
    }
  }
});

test("pairing: without --pair nothing is sent and the event has no paired", async () => {
  const server = await startServer(true);
  try {
    const events: ComputerApiEvent[] = [];
    await runDeviceAuthorization(server.baseUrl, GRANT, { onEvent: (e) => events.push(e) });
    assert.equal("pairingId" in server.authorizeBodies[0]!, false);
    assert.equal("serverSlug" in server.authorizeBodies[0]!, false);
    assert.equal("paired" in deviceCodeEvent(events), false);
  } finally {
    await server.close();
  }
});

test("pairing: never sent without a computer grant (the legacy device session)", async () => {
  const server = await startServer(true);
  try {
    const events: ComputerApiEvent[] = [];
    await runDeviceAuthorization(server.baseUrl, undefined, { pairing: PAIRING, onEvent: (e) => events.push(e) });
    assert.equal("pairingId" in server.authorizeBodies[0]!, false);
    assert.equal("paired" in deviceCodeEvent(events), false);
  } finally {
    await server.close();
  }
});

test("pairing: a loopback authorize never carries it; the device-code fallback after it does", async () => {
  const server = await startServer(true);
  try {
    const events: ComputerApiEvent[] = [];
    await runDeviceAuthorization(server.baseUrl, GRANT, {
      pairing: PAIRING,
      // The browser cannot be started: loopback falls back to a fresh device code.
      loopback: { openBrowser: async () => false },
      onEvent: (e) => events.push(e),
    });
    assert.equal(server.authorizeBodies.length, 2);
    const [loopback, device] = server.authorizeBodies;
    assert.ok(loopback?.loopback);
    assert.equal("pairingId" in loopback!, false);
    assert.equal("serverSlug" in loopback!, false);
    assert.equal(device?.loopback, undefined);
    assert.equal(device?.pairingId, PAIRING.pairingId);
    assert.equal(deviceCodeEvent(events).paired, true);
  } finally {
    await server.close();
  }
});
