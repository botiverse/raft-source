import assert from "node:assert/strict";
import { test } from "vitest";
import { findIntegrationService, findListedIntegrationService } from "./findService";

const apps = [
  { id: "uuid-1", clientId: "renamed-app", name: "Renamed App" },
  { id: "uuid-2", clientId: "other-app", name: "old-id" },
];

test("listed: by id or client id, never by name", () => {
  assert.equal(findListedIntegrationService(apps, "uuid-1")?.id, "uuid-1");
  assert.equal(findListedIntegrationService(apps, "OTHER-APP")?.id, "uuid-2");
  assert.equal(findListedIntegrationService(apps, "old-id"), null, "a name needs the server");
});

test("the server's answer: an old id finds its App, not the App named like it; null finds nothing", () => {
  assert.equal(findIntegrationService({ services: apps, resolvedServiceId: "uuid-1" }, "old-id")?.id, "uuid-1");
  assert.equal(findIntegrationService({ services: apps, resolvedServiceId: null }, "old-id"), null);
});

test("no answer from the server (older server, ambiguous name): the name, as before", () => {
  assert.equal(findIntegrationService({ services: apps }, "old-id")?.id, "uuid-2");
  assert.equal(findIntegrationService({ services: apps }, "  "), null);
});
