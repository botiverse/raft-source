import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function readSource(path: string): string {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

test("channel settings member avatar names use controlled raft-ui tooltips", () => {
  const source = readSource("src/components/channel/ChannelOverflowMenu.tsx");

  assert.match(source, /import \{ TooltipProvider \} from "raft-ui";/);
  assert.match(source, /import Tooltip from "\.\.\/ui\/Tooltip";/);
  assert.match(source, /export const MEMBERS_STRIP_TOOLTIP_DELAY_MS = 250;/);
  assert.match(source, /<TooltipProvider delay=\{MEMBERS_STRIP_TOOLTIP_DELAY_MS\}>/);
  assert.match(source, /<MemberStripTooltip key=\{human\.id\} label=\{label\}>/);
  assert.match(source, /<MemberStripTooltip key=\{agent\.id\} label=\{label\}>/);
  assert.doesNotMatch(source, /title=\{human\.displayName \?\? human\.name\}/);
  assert.doesNotMatch(source, /title=\{agent\.displayName \?\? agent\.name\}/);
});
