import assert from "node:assert/strict";
import { appRecommendations } from "../src/components/apps/appsRecommendations";
import type { MarketplaceOAuthClientRecord } from "../src/features/apps/connected-apps/oauthClientRecords";

// "Recommended for you" on the Apps page: Stamp, while the Marketplace lists it
// for this Server, it isn't installed, and no person here uninstalled it.
const stamp = (over: Partial<MarketplaceOAuthClientRecord>): MarketplaceOAuthClientRecord =>
  ({ clientId: "stamp", official: true, serverId: "raft-official", privateShared: false, installedAt: null, ...over }) as MarketplaceOAuthClientRecord;
const ids = (records: MarketplaceOAuthClientRecord[]) => appRecommendations(records, "server-1").map((r) => r.record.clientId);

test("Stamp is recommended while it isn't installed", () => {
  assert.deepEqual(ids([stamp({})]), ["stamp"]);
  assert.deepEqual(ids([stamp({ uninstalledHereAt: null })]), ["stamp"]);
});

test("an older server sends no uninstalledHereAt: still recommended", () => {
  const record = stamp({});
  assert.equal("uninstalledHereAt" in record, false);
  assert.deepEqual(ids([record]), ["stamp"]);
});

test("a Server where a person uninstalled it isn't asked again", () => {
  assert.deepEqual(ids([stamp({ uninstalledHereAt: "2026-11-01T08:00:00.000Z" })]), []);
});

test("installed, or not the official App by that id: not recommended", () => {
  assert.deepEqual(ids([stamp({ installedAt: "2026-11-02T08:00:00.000Z" })]), []);
  assert.deepEqual(ids([stamp({ installedAt: "2026-11-02T08:00:00.000Z", uninstalledHereAt: "2026-11-01T08:00:00.000Z" })]), []);
  assert.deepEqual(ids([stamp({ official: false })]), []);
});
