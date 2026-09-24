import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

test("channel member searches use a real 16px font on coarse pointers without scale or viewport hacks", () => {
  const css = read("src/index.css");
  const members = read("src/components/agent/ChannelMembers.tsx");
  const legacyMembers = read("src/components/agent/LegacyChannelMembers.tsx");
  const createChannel = read("src/components/channel/CreateChannelDialog.tsx");
  const createJoint = read("src/components/channel/CreateJointChannelDialog.tsx");

  assert.match(
    css,
    /\.input-member-search\s*\{\s*font-size:\s*0\.875rem;\s*\}[\s\S]*?@media \(pointer: coarse\)\s*\{\s*\.input-member-search\s*\{\s*font-size:\s*16px;/,
    "member search must stay 14px on desktop and become a real 16px control on touch-primary devices",
  );
  assert.doesNotMatch(
    css,
    /\.input-member-search[\s\S]{0,240}(?:transform\s*:|scale\s*\()/,
    "the iOS fix must not visually scale a logically larger input",
  );

  assert.equal(
    members.match(/input-brutal input-member-search w-full pl-9/g)?.length,
    3,
    "members page, add flow, and gated modal must share the mobile-safe search class",
  );
  assert.equal(
    legacyMembers.match(/input-brutal input-member-search w-full pl-9/g)?.length,
    1,
    "the flag-off legacy member modal must keep the same mobile-safe search class",
  );
  assert.equal(
    createChannel.match(/input-brutal input-member-search w-full pl-9/g)?.length,
    1,
    "ordinary channel member picker must share the same iOS-safe search class",
  );
  assert.equal(
    createJoint.match(/input-brutal input-member-search w-full pl-9/g)?.length,
    1,
    "Joint channel member picker must share the same iOS-safe search class",
  );
});
