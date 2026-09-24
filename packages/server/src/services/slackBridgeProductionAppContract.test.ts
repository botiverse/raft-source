import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import {
  SLACK_BRIDGE_ACTIVE_BOT_SCOPES,
  SLACK_BRIDGE_PREAUTHORIZED_BOT_SCOPES,
  SLACK_BRIDGE_PREAUTHORIZED_CAPABILITIES,
  SLACK_BRIDGE_PRODUCTION_APP_OPERATOR_POLICY,
  SLACK_BRIDGE_PRODUCTION_EVENTS_REQUEST_URL,
  SLACK_BRIDGE_PRODUCTION_OAUTH_REDIRECT_URI,
  SLACK_BRIDGE_REQUIRED_BOT_EVENTS,
  SLACK_BRIDGE_REQUIRED_BOT_SCOPES,
  SLACK_BRIDGE_STAGING_EVENTS_REQUEST_URL,
  SLACK_BRIDGE_STAGING_OAUTH_REDIRECT_URI,
} from "./slackBridgeProductionAppContract.js";

const productionManifestUrl = new URL(
  "../../../../infra/slack-bridge/production-app-manifest.json",
  import.meta.url,
);
const stagingManifestUrl = new URL(
  "../../../../infra/slack-bridge/staging-app-manifest.json",
  import.meta.url,
);

// Asserts on private CI/deploy files that the source-available snapshot does not
// carry; skipped when an exported snapshot's RELEASE_SOURCE marker is present.
const inSourceSnapshot = existsSync(new URL("../../../../RELEASE_SOURCE", import.meta.url));

async function manifest(url: URL): Promise<Record<string, any>> {
  return JSON.parse(await readFile(url, "utf8")) as Record<string, any>;
}

function secretShapedPaths(value: unknown, path = "$", found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => secretShapedPaths(item, `${path}[${index}]`, found));
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (/(?:client_?secret|signing_?secret|access_?token|refresh_?token|private_?key)/i.test(key)) {
      found.push(nestedPath);
    }
    secretShapedPaths(nested, nestedPath, found);
  }
  return found;
}

test.skipIf(inSourceSnapshot)("production Slack manifest is exact, HTTPS-only, and secret-free", async () => {
  const app = await manifest(productionManifestUrl);
  assert.equal(app._metadata?.major_version, 2);
  assert.deepEqual(app.oauth_config?.redirect_urls, [
    SLACK_BRIDGE_PRODUCTION_OAUTH_REDIRECT_URI,
  ]);
  assert.deepEqual(app.oauth_config?.scopes?.bot, [
    ...SLACK_BRIDGE_REQUIRED_BOT_SCOPES,
  ]);
  assert.equal(
    app.settings?.event_subscriptions?.request_url,
    SLACK_BRIDGE_PRODUCTION_EVENTS_REQUEST_URL,
  );
  assert.deepEqual(app.settings?.event_subscriptions?.bot_events, [
    ...SLACK_BRIDGE_REQUIRED_BOT_EVENTS,
  ]);
  assert.deepEqual(app.settings?.interactivity, { is_enabled: false });
  assert.equal(app.settings?.token_rotation_enabled, false);
  assert.equal(app.settings?.socket_mode_enabled, false);
  assert.equal(app.settings?.org_deploy_enabled, false);
  assert.equal(app.features?.slash_commands, undefined);
  assert.equal(app.features?.incoming_webhooks, undefined);
  assert.deepEqual(secretShapedPaths(app), []);
  assert.equal(new URL(SLACK_BRIDGE_PRODUCTION_OAUTH_REDIRECT_URI).protocol, "https:");
  assert.equal(new URL(SLACK_BRIDGE_PRODUCTION_EVENTS_REQUEST_URL).protocol, "https:");
});

test.skipIf(inSourceSnapshot)("staging Slack manifest is isolated, exact, and production-compatible", async () => {
  const production = await manifest(productionManifestUrl);
  const staging = await manifest(stagingManifestUrl);

  assert.equal(staging.display_information?.name, "Raft Bridge Staging");
  assert.equal(staging.features?.bot_user?.display_name, "Raft Staging");
  assert.deepEqual(staging.oauth_config?.redirect_urls, [
    SLACK_BRIDGE_STAGING_OAUTH_REDIRECT_URI,
  ]);
  assert.equal(
    staging.settings?.event_subscriptions?.request_url,
    SLACK_BRIDGE_STAGING_EVENTS_REQUEST_URL,
  );
  assert.notEqual(
    SLACK_BRIDGE_STAGING_OAUTH_REDIRECT_URI,
    SLACK_BRIDGE_PRODUCTION_OAUTH_REDIRECT_URI,
  );
  assert.notEqual(
    SLACK_BRIDGE_STAGING_EVENTS_REQUEST_URL,
    SLACK_BRIDGE_PRODUCTION_EVENTS_REQUEST_URL,
  );

  assert.deepEqual(staging.oauth_config?.scopes, production.oauth_config?.scopes);
  assert.deepEqual(
    staging.settings?.event_subscriptions?.bot_events,
    production.settings?.event_subscriptions?.bot_events,
  );
  assert.deepEqual(staging.settings?.interactivity, { is_enabled: false });
  assert.equal(staging.settings?.token_rotation_enabled, false);
  assert.equal(staging.settings?.socket_mode_enabled, false);
  assert.equal(staging.settings?.org_deploy_enabled, false);
  assert.equal(staging.features?.slash_commands, undefined);
  assert.equal(staging.features?.incoming_webhooks, undefined);
  assert.deepEqual(secretShapedPaths(staging), []);
  assert.equal(new URL(SLACK_BRIDGE_STAGING_OAUTH_REDIRECT_URI).protocol, "https:");
  assert.equal(new URL(SLACK_BRIDGE_STAGING_EVENTS_REQUEST_URL).protocol, "https:");
});

test("initial install closes the approved future-scope reauthorization gap", () => {
  assert.deepEqual(SLACK_BRIDGE_ACTIVE_BOT_SCOPES, [
    "channels:history",
    "channels:read",
    "chat:write",
    "chat:write.customize",
    "groups:history",
    "groups:read",
    "users:read",
  ], "preauthorization must not silently expand the executable capability manifest");
  const partition = [
    ...SLACK_BRIDGE_ACTIVE_BOT_SCOPES,
    ...SLACK_BRIDGE_PREAUTHORIZED_BOT_SCOPES,
  ].sort();
  assert.deepEqual(partition, [...SLACK_BRIDGE_REQUIRED_BOT_SCOPES].sort());
  assert.deepEqual(SLACK_BRIDGE_PREAUTHORIZED_BOT_SCOPES, [
    "files:read",
    "files:write",
    "reactions:read",
    "reactions:write",
  ]);
  assert.ok(
    SLACK_BRIDGE_PREAUTHORIZED_CAPABILITIES.every((capability) => !capability.defaultEnabled),
    "preauthorization must never silently enable a product behavior",
  );
  assert.deepEqual(
    SLACK_BRIDGE_PREAUTHORIZED_CAPABILITIES.map((capability) => capability.id),
    ["attachment_transfer", "reaction_sync", "message_edit_delete_sync"],
  );
  for (const capability of SLACK_BRIDGE_PREAUTHORIZED_CAPABILITIES) {
    for (const scope of capability.scopes) {
      assert.ok(
        SLACK_BRIDGE_REQUIRED_BOT_SCOPES.includes(scope),
        `${capability.id} scope ${scope} must be requested on the initial install`,
      );
    }
    for (const event of capability.events) {
      assert.ok(
        SLACK_BRIDGE_REQUIRED_BOT_EVENTS.includes(event),
        `${capability.id} event ${event} must be present before launch`,
      );
    }
  }
});

test("cross-workspace OAuth distribution is unlisted while unrelated App controls remain off", () => {
  assert.deepEqual(SLACK_BRIDGE_PRODUCTION_APP_OPERATOR_POLICY, {
    distribution: "unlisted_public_oauth",
    tokenRotation: "off",
    pkce: "off",
    socketMode: "off",
    orgDeploy: "off",
    interactivity: "off",
  });
});
