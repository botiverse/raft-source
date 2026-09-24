import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const overlay = readFileSync(resolve(import.meta.dirname, "../src/components/dev/DraggableDevOverlay.tsx"), "utf8");
const app = readFileSync(resolve(import.meta.dirname, "../src/App.tsx"), "utf8");

test("dev overlay uses RUI Popover with live anchor tracking", () => {
  assert.match(overlay, /from "raft-ui"/);
  assert.match(overlay, /<PopoverTrigger nativeButton=\{false\} render=\{trigger\}/);
  assert.match(overlay, /<PopoverContent/);
  assert.match(overlay, /disableAnchorTracking=\{false\}/);
  assert.match(overlay, /left: \(position\?\.left \?\? 0\) \+ \(transform\?\.x \?\? 0\)/);
});

test("edge release persists collapsed state and keyboard affordance remains", () => {
  assert.match(overlay, /data-dev-overlay-collapsed/);
  assert.match(overlay, /onKeyDown=\{\(event\)/);
  assert.match(overlay, /collapsed: Boolean\(collapsible\)/);
  assert.match(app, /collapsedChildren/);
  assert.match(app, /data-dev-overlay-handle/);
});

test("dev panel keeps header rows and close control geometry stable", () => {
  assert.match(app, /<div className="truncate">\{envName \|\| "slockdev"\}<\/div>/);
  assert.match(app, /<div className="truncate">/);
  assert.match(app, /size="icon-xs"/);
  assert.match(app, /data-testid="raftdev-debug-close"/);
  assert.match(app, /className="size-6 shrink-0 self-start"/);
  assert.match(app, /className="flex size-6 touch-none/);
  assert.match(app, /<Settings2 size=\{12\}/);
});

test("server picker records a one-shot selection request before navigation", () => {
  assert.match(app, /requestServerSelection\(\);\n\s+serverPersistence\.clearLastServerSlug\(\);\n\s+window\.location\.assign\("\/"\);/);
  assert.match(app, /const \[showServerSelector\] = useState\(\(\) => consumeServerSelectionRequest\(\)\);/);
});
