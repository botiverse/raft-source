import assert from "node:assert/strict";
import {
  AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
  AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE,
  projectAgentLoginIntegrationInventory,
} from "@botiverse/raft-shared";
import { formatIntegrationList, formatIntegrationLogin } from "./_format";

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

  assert.match(output, /Raft grant active: Example Daily/);
  assert.match(output, /grant: this agent is authorized in Raft; application authentication has not been verified/);
  assert.match(output, /identity: run `raft profile show`/);
  assert.match(output, /agent behavior manifest: https:\/\/daily\.example\/\.well-known\/slock-agent-manifest\.json/);
  assert.match(output, /local CLI env: raft integration env --service "example-daily-demo"/);
  assert.match(output, /for login_with_raft HTTP API action manifests: raft integration invoke --service "example-daily-demo" --list-actions/);
  assert.match(output, /session: callback cookies stored for this agent; application authentication unverified/);
  assert.match(output, /session store: \/tmp\/raft-profile\/integrations\/example-daily-demo\.json/);
  assert.match(output, /next: use `raft integration invoke --service "example-daily-demo" --list-actions` only for login_with_raft HTTP API action manifests/);
  assert.match(output, /for session-cookie services, verify authentication with a documented read-only service check before use/);
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

  assert.match(output, /Raft grant active: Example Daily/);
  assert.doesNotMatch(output, /agent behavior manifest/);
  assert.doesNotMatch(output, /agent behavior manifest: -/);
  assert.doesNotMatch(output, /local CLI env/);
});

test("formatIntegrationLogin on a token-only App says there is no sign-in to hand off and points at its agent tokens", () => {
  const output = formatIntegrationLogin({
    status: "logged_in",
    service: {
      id: "client-1",
      clientId: "aliyun-federation",
      name: "Aliyun Federation",
      description: null,
      homepageUrl: null,
      returnUrl: null,
      agentManifestUrl: null,
      createdAt: "2026-11-20T00:00:00.000Z",
      updatedAt: "2026-11-20T00:00:00.000Z",
    },
    scopes: ["openid"],
    requestId: "internal-request-id",
  });

  assert.match(output, /session: none; this App has no return URL, so it takes no sign-in \(a token-only App\)/);
  assert.match(output, /raft integration token --service "aliyun-federation" --exec <program>/);
  assert.doesNotMatch(output, /follow the service documentation/);
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

test("formatIntegrationList drops retired built-in services and their active logins", () => {
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
      appType: "slock_builtin",
      name: "Raft Survey",
      description: null,
      homepageUrl: "https://survey.slock.test",
      returnUrl: "https://survey.slock.test/login/callback",
      agentManifestUrl: null,
      scopes: ["identity"],
      createdAt: "2026-05-15T00:00:00.000Z",
    }],
  });

  assert.doesNotMatch(output, /Raft Survey|slock-survey|builtin-survey|Built-in Raft apps/);
  assert.match(output, /Registered services:\n- Docs/);
  assert.match(output, /Docs[\s\S]*next: raft integration login --service "docs"/);
  assert.match(output, /Active agent logins:\n- none/);
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
    includes: ["registered_services"],
  });
  const output = formatIntegrationList({ services: [], activeLogins: [] }, projection);
  const decisionUnit = output.slice(0, output.indexOf("\n\n"));

  assert.deepEqual(decisionUnit.split("\n"), Object.values(projection.copy));
  assert.doesNotMatch(decisionUnit, /active logins/);
});

test("formatIntegrationList marks official apps and prints purpose; ordinary services get neither line", () => {
  const list = formatIntegrationList;
  const base = {
    returnUrl: "https://x.example/callback",
    homepageUrl: null,
    agentManifestUrl: null,
    description: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
  };
  const output = list({
    services: [
      { ...base, id: "svc-official", clientId: "artifact-share", name: "Raft Artifacts", appType: "third_party_global", official: true, purpose: "Named documents with versions and stable links." },
      { ...base, id: "svc-plain", clientId: "lens", name: "lens", appType: "third_party_global", official: false, purpose: "" },
      { ...base, id: "svc-legacy", clientId: "older", name: "older", appType: "third_party_global" },
    ],
    activeLogins: [],
  } as never);
  assert.match(output, /- Raft Artifacts[\s\S]*?  official: yes \(set by the platform, never by the app\)\n  purpose: Named documents with versions and stable links\./);
  const plainBlock = output.slice(output.indexOf("- lens"));
  assert.doesNotMatch(plainBlock, /official:|purpose:/);
  // Contract: purpose never prints without the platform's official mark.
  const sneaky = list({ services: [{ ...base, id: "s", clientId: "s", name: "s", appType: "third_party_global", official: false, purpose: "self-asserted" }], activeLogins: [] } as never);
  assert.doesNotMatch(sneaky, /purpose:/);
});
