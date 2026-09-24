#!/usr/bin/env tsx

import { pathToFileURL } from "node:url";
import { closeDatabase, initDatabase } from "../src/db/index.js";
import {
  reconcileSlackBridgeOAuthIdentityAppType,
  slackBridgeProvisioningManifestHash,
  SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
  type SlackBridgeOAuthIdentityAppType,
} from "../src/services/slackBridgeProvisioningControlPlane.js";
import {
  SLACK_BRIDGE_OAUTH_CLIENT_SECRET_REF,
  SLACK_BRIDGE_SIGNING_SECRET_REF,
} from "../src/services/slackBridgeEnvSecrets.js";

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function slackBridgeOAuthIdentityReconcileDirection(argv: string[]): {
  expectedAppType: SlackBridgeOAuthIdentityAppType;
  nextAppType: SlackBridgeOAuthIdentityAppType;
  dryRun: boolean;
  expectedAuthoritySha256?: string;
} {
  // Accept the conventional `pnpm run <script> -- <args>` separator as well
  // as pnpm's direct `<script> <args>` form. The separator is not part of the
  // operator contract and must never change the parsed transition.
  if (argv[0] === "--") argv = argv.slice(1);
  if ((argv.length !== 2 && argv.length !== 4) || argv[0] !== "--direction") {
    throw new Error("Usage: reconcile-slack-bridge-oauth-identity.ts --direction inspect|forward|rollback [--expected-authority-sha256 <sha256>]");
  }
  if (argv[1] === "inspect") {
    if (argv.length !== 2) throw new Error("inspect does not accept an authority fingerprint");
    return { expectedAppType: "slock_builtin", nextAppType: "slock_builtin", dryRun: true };
  }
  if (argv[2] !== "--expected-authority-sha256" || !/^[0-9a-f]{64}$/.test(argv[3] ?? "")) {
    throw new Error("forward and rollback require --expected-authority-sha256 <64 lowercase hex>");
  }
  if (argv[1] === "forward") {
    return {
      expectedAppType: "slock_builtin",
      nextAppType: "third_party_global",
      dryRun: false,
      expectedAuthoritySha256: argv[3],
    };
  }
  if (argv[1] === "rollback") {
    return {
      expectedAppType: "third_party_global",
      nextAppType: "slock_builtin",
      dryRun: false,
      expectedAuthoritySha256: argv[3],
    };
  }
  throw new Error("--direction must be inspect, forward, or rollback");
}

export type SlackBridgeOAuthIdentityReconcileCliDependencies = {
  initDatabase: typeof initDatabase;
  closeDatabase: typeof closeDatabase;
  reconcile: typeof reconcileSlackBridgeOAuthIdentityAppType;
  write: (text: string) => void;
};

export const SLACK_BRIDGE_OAUTH_IDENTITY_RECONCILE_CLI_DEPENDENCIES:
  SlackBridgeOAuthIdentityReconcileCliDependencies = Object.freeze({
    initDatabase,
    closeDatabase,
    reconcile: reconcileSlackBridgeOAuthIdentityAppType,
    write: (text) => process.stdout.write(text),
  });

export async function runSlackBridgeOAuthIdentityReconcileCli(input: {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  dependencies?: SlackBridgeOAuthIdentityReconcileCliDependencies;
} = {}): Promise<void> {
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  const dependencies = input.dependencies
    ?? SLACK_BRIDGE_OAUTH_IDENTITY_RECONCILE_CLI_DEPENDENCIES;
  const databaseUrl = requiredEnv(env, "DATABASE_URL");
  const transition = slackBridgeOAuthIdentityReconcileDirection(argv);
  const environment = requiredEnv(env, "SLACK_BRIDGE_ENVIRONMENT");
  if (environment !== "test" && environment !== "production") {
    throw new Error("SLACK_BRIDGE_ENVIRONMENT must be test or production");
  }
  const registrationId = requiredEnv(env, "SLACK_BRIDGE_REGISTRATION_ID");
  const oauthRedirectUri = requiredEnv(env, "SLACK_BRIDGE_OAUTH_REDIRECT_URI");
  const eventsRequestUrl = requiredEnv(env, "SLACK_BRIDGE_EVENTS_REQUEST_URL");

  await dependencies.initDatabase(databaseUrl, undefined, {
    // stdout is a machine-readable one-line JSON receipt. Keep database
    // diagnostics visible without corrupting that contract.
    log: (...args) => console.error(...args),
  });
  try {
    const receipt = await dependencies.reconcile({
      bootstrap: {
        registrationId,
        environment,
        providerAppId: requiredEnv(env, "SLACK_BRIDGE_PROVIDER_APP_ID"),
        providerOAuthClientId: requiredEnv(
          env,
          "SLACK_BRIDGE_PROVIDER_OAUTH_CLIENT_ID",
        ),
        oauthRedirectUri,
        eventsRequestUrl,
        capabilityManifestVersion: 1,
        capabilityManifestHash: slackBridgeProvisioningManifestHash({
          oauthRedirectUri,
          eventsRequestUrl,
        }),
        requiredCapabilities: SLACK_BRIDGE_PROVISIONING_CAPABILITIES,
        signingSecret: {
          encryptedSecretRef: SLACK_BRIDGE_SIGNING_SECRET_REF,
          envelopeKeyId: "env:process",
          secretRevision: 1,
        },
        oauthClientSecret: {
          encryptedSecretRef: SLACK_BRIDGE_OAUTH_CLIENT_SECRET_REF,
          envelopeKeyId: "env:process",
          secretRevision: 1,
        },
      },
      ...transition,
    });
    dependencies.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await dependencies.closeDatabase();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSlackBridgeOAuthIdentityReconcileCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
