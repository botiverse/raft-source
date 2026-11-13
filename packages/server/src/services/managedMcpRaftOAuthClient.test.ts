import assert from "node:assert/strict";
import { managedMcpOAuthClientPolicy } from "@botiverse/raft-shared";
import { availableRaftOAuthClientKind } from "./managedMcpRaftOAuthClient";

const ENV_KEYS = ["MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID", "MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET", "MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SERVICES"] as const;

function withEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>, run: () => void): void {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    run();
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

const policy = (service: string) => managedMcpOAuthClientPolicy(`https://${service}mcp.googleapis.com/mcp/v1`);
const client = { MANAGED_MCP_GOOGLE_OAUTH_CLIENT_ID: "synthetic-id", MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SECRET: "synthetic-secret" };

test("Raft's Google client covers every Google MCP service unless the deployment lists some", () => {
  withEnv(client, () => {
    for (const service of ["docs", "sheets", "slides", "drive", "gmail", "calendar"]) {
      assert.equal(availableRaftOAuthClientKind(policy(service)), "google", service);
    }
  });
  // Production's first Google project declares only the scopes approved so far.
  withEnv({ ...client, MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SERVICES: " Docs, sheets,slides ,calendar" }, () => {
    for (const service of ["docs", "sheets", "slides", "calendar"]) assert.equal(availableRaftOAuthClientKind(policy(service)), "google", service);
    for (const service of ["drive", "gmail"]) assert.equal(availableRaftOAuthClientKind(policy(service)), null, `${service} keeps the own-client form`);
  });
  withEnv({ ...client, MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SERVICES: "" }, () => {
    assert.equal(availableRaftOAuthClientKind(policy("docs")), null, "an empty list covers nothing");
  });
  withEnv({ MANAGED_MCP_GOOGLE_OAUTH_CLIENT_SERVICES: "docs" }, () => {
    assert.equal(availableRaftOAuthClientKind(policy("docs")), null, "no client, no Raft sign-in");
  });
  withEnv(client, () => {
    assert.equal(availableRaftOAuthClientKind(managedMcpOAuthClientPolicy("https://mcp.notion.com/mcp")), null);
  });
});
