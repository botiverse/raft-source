import assert from "node:assert/strict";
import test from "node:test";

import {
  projectActionPrepareReceipt,
  projectAppListReceipt,
  projectAppLogoReceipt,
  projectAppManageReceipt,
  projectAppPrepareReceipt,
  projectAppRotateSecretToFileReceipt,
  projectAppStatusReceipt,
  projectAppTransferOwnerReceipt,
  projectAppUpdateReceipt,
} from "./appReceipts.js";

const app = {
  state: "committed" as const,
  card: null,
  name: "Demo App",
  clientKey: "demo-app",
  createdAt: "2026-07-21T00:00:00.000Z",
  callbackUrl: "https://demo.example/auth/raft/callback",
  scopes: ["openid"],
  category: "Developer Tools",
  recoveryCommand: "raft integration app rotate-secret --client demo-app --output <new-private-path>",
  client_secret: "owned_app_alias_must_not_render",
  credentials: { clientSecret: "owned_app_nested_must_not_render" },
  unknownTopLevel: "owned_app_unknown_must_not_render",
};

test("direct app read receipts recursively project only declared app fields", () => {
  const list = projectAppListReceipt({
    apps: [app],
    token: "list_top_level_must_not_render",
  } as never);
  const status = projectAppStatusReceipt({
    app,
    token: "status_top_level_must_not_render",
  } as never);

  const wire = JSON.stringify({ list, status });
  assert.doesNotMatch(wire, /must_not_render/);
  assert.deepEqual(list, { apps: [status.app] });
  assert.deepEqual(status, {
    app: {
      state: "committed",
      card: null,
      name: "Demo App",
      clientKey: "demo-app",
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: undefined,
      description: undefined,
      homepageUrl: undefined,
      callbackUrl: "https://demo.example/auth/raft/callback",
      agentManifestUrl: undefined,
      scopes: ["openid"],
      category: "Developer Tools",
      dataAccessSummary: undefined,
      logoUrl: undefined,
      appType: undefined,
      publishStatus: undefined,
      enabled: undefined,
      authority: undefined,
      recoveryCommand: "raft integration app rotate-secret --client demo-app --output <new-private-path>",
    },
  });
});

test("direct app mutation receipts use action-specific fixed projections", () => {
  const injected = {
    clientId: "client-1",
    clientKey: "demo-app",
    clientName: "Demo App",
    clientSecret: "primary-show-once-secret",
    updatedFields: ["returnUrl"],
    ownerAgentId: "agent-2",
    ownerAgentName: "box",
    ownershipOutcome: "already_owner" as const,
    auditEventId: "11111111-1111-4111-8111-111111111112",
    client_secret: "mutation_alias_must_not_render",
    credentials: { clientSecret: "mutation_nested_must_not_render" },
    unknownTopLevel: "mutation_unknown_must_not_render",
  };

  const receipts = {
    update: projectAppUpdateReceipt(injected),
    transfer: projectAppTransferOwnerReceipt(injected),
    rotateToFile: projectAppRotateSecretToFileReceipt(injected, {
      path: "/private/secret",
      mode: "0600",
      created: true,
      containsSecret: true,
      selection: "agent-selected",
      binding: "caller-managed-after-return",
    }),
  };

  const wire = JSON.stringify(receipts);
  assert.doesNotMatch(wire, /mutation_alias_must_not_render|mutation_nested_must_not_render|mutation_unknown_must_not_render/);
  assert.doesNotMatch(wire, /primary-show-once-secret/);
  assert.deepEqual(receipts.update, {
    clientId: "client-1",
    clientKey: "demo-app",
    clientName: "Demo App",
    updatedFields: ["returnUrl"],
  });
  assert.deepEqual(receipts.transfer, {
    clientId: "client-1",
    clientKey: "demo-app",
    clientName: "Demo App",
    ownerAgentId: "agent-2",
    ownerAgentName: "box",
    ownershipOutcome: "already_owner",
    auditEventId: "11111111-1111-4111-8111-111111111112",
  });
});

test("remaining direct app receipts also drop undeclared response fields", () => {
  const receipts = {
    prepare: projectAppPrepareReceipt({
      status: "prepared",
      mode: "register",
      target: "#proj-raft-app",
      actionCardMessageId: "card-1",
      action: {
        type: "integration:register_app",
        name: "Demo App",
        returnUrl: "https://demo.example/callback",
        scopes: ["openid"],
        draftHint: "register demo",
        credentials: { clientSecret: "prepare_nested_must_not_render" },
      },
      token: "prepare_unknown_must_not_render",
    } as never),
    manage: projectAppManageReceipt({
      action: "share_link_create",
      clientId: "client-1",
      clientKey: "demo-app",
      clientName: "Demo App",
      shareUrl: "https://demo.example/share/allowed-token",
      link: {
        id: "link-1",
        expiresAt: null,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        credentials: { clientSecret: "manage_link_nested_must_not_render" },
      },
      client_secret: "manage_alias_must_not_render",
      unknownTopLevel: "manage_unknown_must_not_render",
    } as never),
    logo: projectAppLogoReceipt({
      clientId: "client-1",
      clientKey: "demo-app",
      clientName: "Demo App",
      logoUrl: "https://demo.example/logo.png",
      client_secret: "logo_alias_must_not_render",
      unknownTopLevel: "logo_unknown_must_not_render",
    } as never),
    actionPrepare: projectActionPrepareReceipt({
      messageId: "message-1",
      metadata: {
        kind: "action-card",
        credentials: { clientSecret: "action_nested_must_not_render" },
      },
      unknownTopLevel: "action_unknown_must_not_render",
    } as never),
  };

  const wire = JSON.stringify(receipts);
  assert.doesNotMatch(wire, /must_not_render/);
  assert.match(wire, /allowed-token/);
  assert.deepEqual(receipts.actionPrepare, {
    messageId: "message-1",
    metadata: { kind: "action-card" },
  });
});
