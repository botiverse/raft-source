// The prompt's first-party app entries (`FIRST_PARTY_APP_GUIDE_ENTRIES` in
// shared `raftCliGuide.ts`) are keyed by registry id, and the guide skips an
// id it has no entry for. So a registry id renamed without the table (or a
// typo in the table) would drop the entry from every prompt silently; here it
// fails instead.
import assert from "node:assert/strict";
import { FIRST_PARTY_APP_GUIDE_ENTRIES } from "@botiverse/raft-shared";
import { firstPartyApps } from "./firstPartyApps";

test("every prompt entry names an app in the registry", () => {
  const ids = new Set(firstPartyApps().map((app) => app.id));
  for (const entry of FIRST_PARTY_APP_GUIDE_ENTRIES) assert.ok(ids.has(entry.appId), `no first-party app "${entry.appId}" in the registry`);
});
