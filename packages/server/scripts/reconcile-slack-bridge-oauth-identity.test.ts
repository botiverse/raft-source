import { describe, expect, it, vi } from "vitest";
import {
  runSlackBridgeOAuthIdentityReconcileCli,
  SLACK_BRIDGE_OAUTH_IDENTITY_RECONCILE_CLI_DEPENDENCIES,
  slackBridgeOAuthIdentityReconcileDirection,
  type SlackBridgeOAuthIdentityReconcileCliDependencies,
} from "./reconcile-slack-bridge-oauth-identity.js";

const ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: "postgres://staging.example.invalid/raft",
  SLACK_BRIDGE_ENVIRONMENT: "production",
  SLACK_BRIDGE_REGISTRATION_ID: "daf8439e-6a5d-4d8c-9958-abef7029357b",
  SLACK_BRIDGE_PROVIDER_APP_ID: "A0BLX3E8RMH",
  SLACK_BRIDGE_PROVIDER_OAUTH_CLIENT_ID: "11710953035571.11711116297731",
  SLACK_BRIDGE_OAUTH_REDIRECT_URI:
    "https://api-aws-staging.botiverse.dev/api/slack-bridge/oauth/callback",
  SLACK_BRIDGE_EVENTS_REQUEST_URL:
    "https://api-aws-staging.botiverse.dev/api/slack-bridge/events",
};

describe("Slack Bridge OAuth identity reconcile CLI", () => {
  it("parses inspect and requires a fingerprint for mutations", () => {
    expect(slackBridgeOAuthIdentityReconcileDirection([
      "--direction",
      "inspect",
    ])).toEqual({
      expectedAppType: "slock_builtin",
      nextAppType: "slock_builtin",
      dryRun: true,
    });
    expect(slackBridgeOAuthIdentityReconcileDirection([
      "--",
      "--direction",
      "inspect",
    ])).toEqual({
      expectedAppType: "slock_builtin",
      nextAppType: "slock_builtin",
      dryRun: true,
    });
    expect(() => slackBridgeOAuthIdentityReconcileDirection([
      "--direction",
      "forward",
    ])).toThrow(/require --expected-authority-sha256/u);
  });

  it("initializes the database before inspect and always closes it", async () => {
    const lifecycle: string[] = [];
    const writes: string[] = [];
    const dependencies = {
      initDatabase: vi.fn(async (databaseUrl: string) => {
        lifecycle.push(`init:${databaseUrl}`);
      }),
      closeDatabase: vi.fn(async () => {
        lifecycle.push("close");
      }),
      reconcile: vi.fn(async (input) => {
        lifecycle.push("reconcile");
        expect(input).toMatchObject({
          expectedAppType: "slock_builtin",
          nextAppType: "slock_builtin",
          dryRun: true,
          bootstrap: {
            registrationId: ENV.SLACK_BRIDGE_REGISTRATION_ID,
            providerAppId: ENV.SLACK_BRIDGE_PROVIDER_APP_ID,
            oauthRedirectUri: ENV.SLACK_BRIDGE_OAUTH_REDIRECT_URI,
            eventsRequestUrl: ENV.SLACK_BRIDGE_EVENTS_REQUEST_URL,
          },
        });
        return { changed: false, authoritySha256: "a".repeat(64) } as never;
      }),
      write: vi.fn((text: string) => {
        writes.push(text);
      }),
    } satisfies SlackBridgeOAuthIdentityReconcileCliDependencies;

    await runSlackBridgeOAuthIdentityReconcileCli({
      argv: ["--direction", "inspect"],
      env: ENV,
      dependencies,
    });

    expect(lifecycle).toEqual([
      `init:${ENV.DATABASE_URL}`,
      "reconcile",
      "close",
    ]);
    expect(writes).toEqual([
      `${JSON.stringify({ changed: false, authoritySha256: "a".repeat(64) })}\n`,
    ]);
  });

  it("closes the database when reconcile rejects", async () => {
    const lifecycle: string[] = [];
    const failure = new Error("inspect rejected");
    const dependencies = {
      initDatabase: vi.fn(async () => {
        lifecycle.push("init");
      }),
      closeDatabase: vi.fn(async () => {
        lifecycle.push("close");
      }),
      reconcile: vi.fn(async () => {
        lifecycle.push("reconcile");
        throw failure;
      }),
      write: vi.fn(),
    } satisfies SlackBridgeOAuthIdentityReconcileCliDependencies;

    await expect(runSlackBridgeOAuthIdentityReconcileCli({
      argv: ["--direction", "inspect"],
      env: ENV,
      dependencies,
    })).rejects.toBe(failure);
    expect(lifecycle).toEqual(["init", "reconcile", "close"]);
    expect(dependencies.write).not.toHaveBeenCalled();
  });

  it("keeps real PostgreSQL initialization diagnostics off structured stdout", async () => {
    const receipt = {
      changed: false,
      authoritySha256: "b".repeat(64),
    };
    const stdout: string[] = [];
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: string | Uint8Array) => {
        stdout.push(String(chunk));
        return true;
      }) as typeof process.stdout.write,
    );
    const stderrCalls: unknown[][] = [];
    const stderr = vi.spyOn(console, "error").mockImplementation((...args) => {
      stderrCalls.push(args);
    });

    try {
      await runSlackBridgeOAuthIdentityReconcileCli({
        argv: ["--", "--direction", "inspect"],
        env: ENV,
        dependencies: {
          ...SLACK_BRIDGE_OAUTH_IDENTITY_RECONCILE_CLI_DEPENDENCIES,
          reconcile: vi.fn(async () => receipt as never),
        },
      });
    } finally {
      stdoutWrite.mockRestore();
      stderr.mockRestore();
    }

    const serialized = stdout.join("");
    expect(serialized).toBe(`${JSON.stringify(receipt)}\n`);
    expect(serialized.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(serialized)).toEqual(receipt);
    expect(stderrCalls).toContainEqual([
      "[db] search: using primary (no replica configured)",
    ]);
  });
});
