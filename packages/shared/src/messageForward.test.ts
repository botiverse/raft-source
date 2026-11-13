import assert from "node:assert/strict";
import {
  FORWARDED_BUNDLE_ATTACHMENT_KEYS,
  FORWARDED_BUNDLE_AUTHOR_KEYS,
  FORWARDED_BUNDLE_ITEM_KEYS,
  FORWARDED_BUNDLE_METADATA_KEYS,
  FORWARDED_BUNDLE_TARGET_KEYS,
} from "./messageForward";

// The mobile App's V2 conversion keeps exactly these keys of a forward, at
// each level (FORWARDED_ROOT_KEYS, FORWARDED_ITEM_KEYS, FORWARDED_AUTHOR_KEYS,
// FORWARDED_TARGET_KEYS and FORWARDED_ATTACHMENT_KEYS in the App's
// CanonicalMessageV2ProductionCanary.kt; the same in its tags 1.16.0 to
// 1.20.0, main 1e916283d and mobile #4370, which drops the other keys from
// App 1.21.0 on; Lagoon, #proj-apps:#40).
const APP_KEPT_FORWARDED_KEYS = {
  root: ["kind", "version", "forwardedItems"],
  item: [
    "index", "sourceMessageId", "sourceAuthorSnapshot", "sourceCreatedAt", "sourceTargetSnapshot",
    "contentSnapshot", "attachmentSnapshots", "provenanceState",
  ],
  author: ["type", "id", "name", "uniqueName"],
  target: ["id", "type", "label", "labelVisibility"],
  attachment: ["filename", "mimeType"],
};

const LISTED = {
  root: FORWARDED_BUNDLE_METADATA_KEYS,
  item: FORWARDED_BUNDLE_ITEM_KEYS,
  author: FORWARDED_BUNDLE_AUTHOR_KEYS,
  target: FORWARDED_BUNDLE_TARGET_KEYS,
  attachment: FORWARDED_BUNDLE_ATTACHMENT_KEYS,
};

test("FORWARDED_BUNDLE_*_KEYS: at each level, what they mark v2-keeps is exactly what the App's V2 keeps", () => {
  for (const [level, keys] of Object.entries(LISTED) as Array<[keyof typeof LISTED, Record<string, "v2-keeps" | "v2-drops">]>) {
    const keeps = Object.entries(keys).filter(([, app]) => app === "v2-keeps").map(([key]) => key).sort();
    assert.deepEqual(keeps, [...APP_KEPT_FORWARDED_KEYS[level]].sort(), level);
  }
});
