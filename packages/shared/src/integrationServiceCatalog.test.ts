import assert from "node:assert/strict";
import { test } from "vitest";
import { matchRequestedService, normalizeServiceName, REQUESTED_SERVICE_ALIASES } from "./integrationServiceCatalog";
import { REQUESTED_SERVICE_KEYS, validateProductEvent } from "./productEvents";

test("a typed service name is one of the listed keys or `other`, never the text", () => {
  for (const key of REQUESTED_SERVICE_KEYS) assert.equal(matchRequestedService(key), key);
  assert.deepEqual(Object.keys(REQUESTED_SERVICE_ALIASES).sort(), [...REQUESTED_SERVICE_KEYS].sort(), "every key has an alias row and nothing else does");

  // Case, spaces and punctuation do not matter; a trailing "mcp" / "app" / "api" is dropped.
  assert.equal(matchRequestedService("Google Mail"), "gmail");
  assert.equal(matchRequestedService("  GMAIL  "), "gmail");
  assert.equal(matchRequestedService("google-calendar"), "google_calendar");
  assert.equal(matchRequestedService("notion-mcp"), "notion");
  assert.equal(matchRequestedService("Linear MCP Server"), "linear");
  assert.equal(matchRequestedService("GitHub App"), "github");
  assert.equal(matchRequestedService("twitter"), "x");
  assert.equal(matchRequestedService("MS Teams"), "microsoft_teams");
  // The Google services stay apart, and MCP template keys map to them.
  assert.equal(matchRequestedService("docs"), "google_docs");
  assert.equal(matchRequestedService("drive"), "google_drive");
  assert.equal(matchRequestedService("sheets"), "google_sheets");
  assert.equal(matchRequestedService("google"), "other");

  // Exact names only: a sentence, an unknown name, an id, or not a string is `other`.
  assert.equal(matchRequestedService("notion to linear sync"), "other");
  assert.equal(matchRequestedService("acme-internal-crm"), "other");
  assert.equal(matchRequestedService("7b0e9d3c-58a7-4d5e-9a57-0d7a1c1f2e11"), "other");
  assert.equal(matchRequestedService(""), "other");
  assert.equal(matchRequestedService("app"), "other", "a bare trailing word is not stripped to nothing");
  assert.equal(matchRequestedService(undefined), "other");
  assert.equal(matchRequestedService(42), "other");
  assert.equal(matchRequestedService(`gmail${" ".repeat(300)}`), "other", "over-long input is not examined");
  assert.equal(normalizeServiceName("Monday.com"), "mondaycom");
});

test("integration_service_requested: a server event with a closed vocabulary", () => {
  const ok = { service: "gmail", outcome: "not_offered", command: "login" };
  assert.deepEqual(validateProductEvent("integration_service_requested", ok, "server"), { ok: true, event: "integration_service_requested" });
  assert.equal(validateProductEvent("integration_service_requested", { ...ok, service: "other", outcome: "not_installed", command: "lookup" }, "server").ok, true);
  assert.deepEqual(validateProductEvent("integration_service_requested", { ...ok, service: "acme-internal-crm" }, "server"), { ok: false, reason: "invalid_property_value", property: "service" });
  assert.deepEqual(validateProductEvent("integration_service_requested", ok, "web"), { ok: false, reason: "source_not_allowed" });
});
