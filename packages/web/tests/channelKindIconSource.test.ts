import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "vitest";

// A channel's kind icon comes from one chooser (components/channel/channelKind
// channelKindIconProps, drawn by channelKindIcon's ChannelIcon) and is the same on every surface (cindyz
// 2026-11-10). Before, the header, inbox, search, pickers, forward targets,
// composer suggestions and settings each picked lucide's # / lock / branch
// from the channel's type, so an external channel showed the sidebar's
// external glyph in one place and a lock or # in the next. This scan keeps a
// surface from picking a kind icon from the type by hand again.

const SRC = path.resolve(__dirname, "../src");
const CHOOSER = path.join(SRC, "components/channel/channelKindIcon.tsx");
// The bounded web apps (src/apps, scripts/ci/check-app-module-boundaries.ts) may
// not import the chooser yet; their scope marks (Artifacts) still pick by type.
const BOUNDED_APPS = path.join(SRC, "apps") + path.sep;
// `type === "private" ? <Lock`, `channelType === "joint") return <GitBranch`, …
const HAND_PICKED = /\b(?:type|channelType)\s*===\s*"(?:private|joint|channel)"\s*(?:\)\s*return|\?)\s*<(?:Hash|Lock|GitBranch)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

test("no surface picks a channel's kind icon from its type by hand: it takes it from ChannelIcon", () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (file === CHOOSER || file.startsWith(BOUNDED_APPS)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (HAND_PICKED.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "use <ChannelIcon channel|channelId … /> (or channelKindIconProps) instead");
});

test("the scan still catches a hand-picked kind icon", () => {
  assert.ok(HAND_PICKED.test(`{channel?.type === "private" ? <Lock /> : <Hash />}`));
  assert.ok(HAND_PICKED.test(`  if (channel.type === "joint") return <GitBranch size={14} />;`));
  assert.ok(!HAND_PICKED.test(`{currentVisibility === "private" ? <Hash size={16} /> : <Lock size={16} />}`), "a visibility switch, not a channel's identity");
});
