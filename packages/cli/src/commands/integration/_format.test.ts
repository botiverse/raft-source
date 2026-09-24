import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
  AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE,
  projectAgentLoginIntegrationInventory,
} from "@botiverse/raft-shared";
import { formatIntegrationList, formatIntegrationLogin } from "./_format.js";

test("formatIntegrationLogin makes agent login completion explicit", () => {
  const output = formatIntegrationLogin({
    status: "logged_in",
    service: {
      id: "client-1",
      clientId: "example-daily-demo",
      name: "Example Daily",
      description: null,
      homepageUrl: "https://daily.example",
      returnUrl: "https://daily.example/login/callback",
      agentManifestUrl: "https://daily.example/.well-known/slock-agent-manifest.json",
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
    },
    scopes: ["identity", "openid", "profile"],
    session: {
      status: "stored",
      source: "fresh",
      path: "/tmp/raft-profile/integrations/example-daily-demo.json",
    },
  });

  assert.match(output, /Agent login ready: Example Daily/);
  assert.match(output, /complete: this agent login is configured in Raft; no human OAuth is required/);
  assert.match(output, /identity: run `raft profile show`/);
  assert.match(output, /agent behavior manifest: https:\/\/daily\.example\/\.well-known\/slock-agent-manifest\.json/);
  assert.match(output, /local CLI env: raft integration env --service "example-daily-demo"/);
  assert.match(output, /for login_with_raft HTTP API action manifests: raft integration invoke --service "example-daily-demo" --list-actions/);
  assert.match(output, /session: service session created and stored for this agent/);
  assert.match(output, /session store: \/tmp\/raft-profile\/integrations\/example-daily-demo\.json/);
  assert.match(output, /next: use `raft integration invoke --service "example-daily-demo" --list-actions` only for login_with_raft HTTP API action manifests/);
  assert.match(output, /for session-cookie services, use the established service session per service docs/);
  assert.doesNotMatch(output, /^app URL:/m);
  assert.doesNotMatch(output, /agent_request_id/);
  assert.doesNotMatch(output, /request id:/);
  assert.doesNotMatch(output, /callback handoff URL/);
  assert.doesNotMatch(output, /internal-request-id/);
});

test("formatIntegrationLogin omits agent manifest line when service has none", () => {
  const output = formatIntegrationLogin({
    status: "logged_in",
    service: {
      id: "client-1",
      clientId: "example-daily-demo",
      name: "Example Daily",
      description: null,
      homepageUrl: "https://daily.example",
      returnUrl: "https://daily.example/login/callback",
      agentManifestUrl: null,
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
    },
    scopes: ["identity"],
    requestId: "internal-request-id",
  });

  assert.match(output, /Agent login ready: Example Daily/);
  assert.doesNotMatch(output, /agent behavior manifest/);
  assert.doesNotMatch(output, /agent behavior manifest: -/);
  assert.doesNotMatch(output, /local CLI env/);
});

test("formatIntegrationLogin explains human approval requirement", () => {
  const output = formatIntegrationLogin({
    status: "approval_required",
    service: {
      id: "client-1",
      clientId: "marketplace-demo",
      name: "Marketplace Demo",
      description: null,
      homepageUrl: "https://marketplace.example",
      returnUrl: "https://marketplace.example/login/callback",
      agentManifestUrl: null,
      createdAt: "2026-05-15T00:00:00.000Z",
      updatedAt: "2026-05-15T00:00:00.000Z",
    },
    scopes: ["identity", "openid", "profile"],
    requestId: "request-1",
    approval: {
      requestId: "request-1",
      target: "#proj-auth:bdc26350",
      actionCardMessageId: "card-1",
    },
  });

  assert.match(output, /Human approval required: Marketplace Demo/);
  assert.match(output, /approval card: card-1/);
  assert.match(output, /target: #proj-auth:bdc26350/);
  assert.match(output, /next: ask a server owner\/admin to approve the card/);
  assert.doesNotMatch(output, /complete: this agent login is configured/);
});

test("formatIntegrationLogin identifies a public app that still needs a Server install", () => {
  const output = formatIntegrationLogin({
    status: "install_required",
    nextAction: "install_from_marketplace",
    service: {
      id: "client-public",
      clientId: "me-build",
      name: "Me Build",
      description: "Build service",
      homepageUrl: "https://me.build",
      returnUrl: "https://me.build/login/callback",
      agentManifestUrl: null,
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    },
    scopes: ["openid", "profile"],
    installation: {
      serverSlug: "botiverse",
      serverName: "Botiverse",
      marketplaceUrl: "https://raft.build/s/botiverse/settings/applications?marketplace_app=client-public",
      target: "#proj-raft-app:8179a143",
      actionCardMessageId: "card-install-1",
    },
  });

  assert.match(output, /Marketplace install required: Me Build/);
  assert.match(output, /next action: install_from_marketplace/);
  assert.match(output, /server: Botiverse/);
  assert.match(output, /marketplace_app=client-public/);
  assert.match(output, /install card: card-install-1/);
  assert.match(output, /ask a server owner\/admin to install/);
  assert.match(output, /the app exists; it is not installed on this Server yet/);
  assert.doesNotMatch(output, /Registered service not found/);
  assert.doesNotMatch(output, /Agent login ready/);
});

test("formatIntegrationList only prints manifest line for services that declare one", () => {
  const output = formatIntegrationList({
    services: [
      {
        id: "client-with-manifest",
        clientId: "with-manifest",
        name: "With Manifest",
        description: null,
        homepageUrl: null,
        returnUrl: "https://with.example/callback",
        agentManifestUrl: "https://with.example/.well-known/slock-agent-manifest.json",
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
      },
      {
        id: "client-without-manifest",
        clientId: "without-manifest",
        name: "Without Manifest",
        description: null,
        homepageUrl: null,
        returnUrl: "https://without.example/callback",
        agentManifestUrl: null,
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
      },
    ],
    activeLogins: [
      {
        id: "login-with-manifest",
        serviceId: "client-with-manifest",
        clientId: "with-manifest",
        name: "With Manifest",
        description: null,
        homepageUrl: null,
        returnUrl: "https://with.example/callback",
        agentManifestUrl: "https://with.example/.well-known/slock-agent-manifest.json",
        scopes: ["identity"],
        createdAt: "2026-05-15T00:00:00.000Z",
      },
      {
        id: "login-without-manifest",
        serviceId: "client-without-manifest",
        clientId: "without-manifest",
        name: "Without Manifest",
        description: null,
        homepageUrl: null,
        returnUrl: "https://without.example/callback",
        agentManifestUrl: null,
        scopes: ["identity"],
        createdAt: "2026-05-15T00:00:00.000Z",
      },
    ],
  });

  assert.match(output, /With Manifest[\s\S]*agent behavior manifest: https:\/\/with\.example\/\.well-known\/slock-agent-manifest\.json/);
  assert.match(output, /With Manifest[\s\S]*local CLI env: raft integration env --service "with-manifest"/);
  assert.match(output, /With Manifest[\s\S]*for login_with_raft HTTP API action manifests: raft integration invoke --service "with-manifest" --list-actions/);
  const withoutManifestBlocks = output.match(/Without Manifest[\s\S]*?(?=\n- |$)/g) ?? [];
  assert.equal(withoutManifestBlocks.length, 2);
  for (const block of withoutManifestBlocks) {
    assert.doesNotMatch(block, /agent behavior manifest/);
  }
  assert.doesNotMatch(output, /agent behavior manifest: -/);
});

test("formatIntegrationList separates built-in Raft apps from registered services", () => {
  const output = formatIntegrationList({
    services: [
      {
        id: "builtin-survey",
        clientId: "slock-survey",
        appType: "slock_builtin",
        name: "Raft Survey",
        description: "First-party survey app",
        homepageUrl: "https://survey.slock.test",
        returnUrl: "https://survey.slock.test/login/callback",
        agentManifestUrl: null,
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
      },
      {
        id: "server-local-docs",
        clientId: "docs",
        appType: "server_local",
        name: "Docs",
        description: null,
        homepageUrl: null,
        returnUrl: "https://docs.example/callback",
        agentManifestUrl: null,
        createdAt: "2026-05-15T00:00:00.000Z",
        updatedAt: "2026-05-15T00:00:00.000Z",
      },
    ],
    activeLogins: [{
      id: "survey-login",
      serviceId: "builtin-survey",
      clientId: "slock-survey",
      name: "Raft Survey",
      description: null,
      homepageUrl: "https://survey.slock.test",
      returnUrl: "https://survey.slock.test/login/callback",
      agentManifestUrl: null,
      scopes: ["identity"],
      createdAt: "2026-05-15T00:00:00.000Z",
    }],
  });

  assert.match(output, /Built-in Raft apps:\n- Raft Survey/);
  assert.match(output, /Raft Survey[\s\S]*type: built-in Raft app/);
  assert.match(output, /Raft Survey[\s\S]*session: active login/);
  assert.doesNotMatch(output, /Raft Survey[\s\S]*next: raft integration login --service "slock-survey"[\s\S]*Registered services:/);
  assert.match(output, /Registered services:\n- Docs/);
  assert.match(output, /Docs[\s\S]*next: raft integration login --service "docs"/);
});

test("formatIntegrationList keeps its observation boundary at the inventory decision point", () => {
  const output = formatIntegrationList({ services: [], activeLogins: [] });
  const decisionUnit = output.slice(0, output.indexOf("\n\n"));

  assert.deepEqual(
    decisionUnit.split("\n"),
    Object.values(AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION.copy),
    "the complete shared scope fact must stay co-located in the receipt's first decision unit",
  );
  assert.ok(
    output.indexOf(AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION.copy.boundary) <
      output.indexOf("Registered services:"),
    "the observation boundary must stay adjacent to the command receipt, before any inventory entries",
  );
});

test("formatIntegrationList projects a structured scope mutation into its first decision unit", () => {
  const projection = projectAgentLoginIntegrationInventory({
    ...AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE,
    includes: ["built_in_raft_apps", "registered_services"],
  });
  const output = formatIntegrationList({ services: [], activeLogins: [] }, projection);
  const decisionUnit = output.slice(0, output.indexOf("\n\n"));

  assert.deepEqual(decisionUnit.split("\n"), Object.values(projection.copy));
  assert.doesNotMatch(decisionUnit, /active logins/);
});
