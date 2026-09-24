import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import {
  decryptManagedMcpHeaders,
  encryptManagedMcpHeaders,
  ManagedMcpCredentialError,
  normalizeManagedMcpHeaders,
} from "./managedMcpCredentialService.js";

const ORIGINAL_KEY = process.env.SLOCK_MCP_CREDENTIAL_KEY;

beforeEach(() => {
  process.env.SLOCK_MCP_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  else process.env.SLOCK_MCP_CREDENTIAL_KEY = ORIGINAL_KEY;
});

test("managed MCP headers encrypt without plaintext and round-trip", () => {
  const headers = { Authorization: "Bearer secret-value", "X-Api-Key": "another-secret" };
  const encrypted = encryptManagedMcpHeaders(headers);

  assert.match(encrypted, /^v1:/u);
  assert.equal(encrypted.includes("secret-value"), false);
  assert.equal(encrypted.includes("another-secret"), false);
  assert.deepEqual(decryptManagedMcpHeaders(encrypted), headers);
});

test("managed MCP credential ciphertext is authenticated", () => {
  const encrypted = encryptManagedMcpHeaders({ Authorization: "Bearer secret" });
  const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => decryptManagedMcpHeaders(tampered), (error: unknown) => (
    error instanceof ManagedMcpCredentialError && error.code === "managed_mcp_credential_invalid"
  ));
});

test("managed MCP credential writes fail closed without a configured key", () => {
  delete process.env.SLOCK_MCP_CREDENTIAL_KEY;
  assert.throws(() => encryptManagedMcpHeaders({ Authorization: "Bearer secret" }), (error: unknown) => (
    error instanceof ManagedMcpCredentialError && error.code === "managed_mcp_credential_key_missing"
  ));
});

test("managed MCP header validation rejects injection and empty values", () => {
  assert.throws(() => normalizeManagedMcpHeaders({ "X-Test\r\nInjected": "value" }), ManagedMcpCredentialError);
  assert.throws(() => normalizeManagedMcpHeaders({ Authorization: "" }), ManagedMcpCredentialError);
  assert.throws(() => normalizeManagedMcpHeaders({ Authorization: "ok\r\nInjected: yes" }), ManagedMcpCredentialError);
  assert.throws(() => normalizeManagedMcpHeaders({ Host: "internal.example" }), ManagedMcpCredentialError);
  assert.throws(() => normalizeManagedMcpHeaders({ Authorization: "one", authorization: "two" }), ManagedMcpCredentialError);
});
