import assert from "node:assert/strict";
import test from "node:test";
import {
  genericAppDocumentTitle,
  getServerRouteDocumentTitle,
  hostShellFallbackDocumentTitle,
  serverRouteAgentId,
  serverRouteMachineId,
} from "../src/utils/browserDocumentTitle";

const server = { name: "Botiverse", slug: "botiverse" };
const fallbacks = {
  agent: "Agent",
  computer: "Computer",
  computers: "Computers",
};

test("server routes keep the server label first by default", () => {
  assert.equal(getServerRouteDocumentTitle("/s/botiverse", server), "Botiverse | Raft");
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/agent/agent-1", server, { agentLabel: "Jony" }),
    "Botiverse | Raft",
  );
  assert.equal(genericAppDocumentTitle(), "Raft");
});

test("host-shell Computers routes publish only the native header title", () => {
  assert.equal(hostShellFallbackDocumentTitle(fallbacks), "Computers");
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/computers", server, {}, true, fallbacks),
    "Computers",
  );
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/computer/machine-1", server, { machineLabel: "Jony's Mac" }, true, fallbacks),
    "Jony's Mac",
  );
  assert.equal(serverRouteMachineId("/s/botiverse/machine/machine-2", server.slug), "machine-2");
});

test("host-shell Computer-to-Agent navigation publishes the loaded Agent display name", () => {
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/agent/agent-1", server, { agentLabel: "Jony" }, true, fallbacks),
    "Jony",
  );
  assert.equal(serverRouteAgentId("/s/botiverse/agent/agent-1", server.slug), "agent-1");
});

test("host-shell detail titles fail soft before their entity store has loaded", () => {
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/agent/agent-1", server, {}, true, fallbacks),
    "Agent",
  );
  assert.equal(
    getServerRouteDocumentTitle("/s/botiverse/computer/machine-1", server, { machineLabel: "A | B" }, true, fallbacks),
    "A | B",
  );
});
