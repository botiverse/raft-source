import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * A sidebar section header's controls (sort, +, invite) go in raft-ui's
 * SidebarSectionTrailing > SidebarSectionControls, never in a wrapper of our
 * own. The design system's part is what makes them 24px hint-colored ghost
 * buttons that show on section hover, keyboard focus or an open menu (always
 * on touch), 20px apart on a touch screen so their 44px hit areas don't
 * overlap, with the last one ending on the rows' content edge. A hand-made
 * `div flex gap-1` around them kept them visible and 4px apart, and is how the
 * header drifted from the design system unnoticed (#proj-raft-ui:#178).
 */

const REPO = resolve(import.meta.dirname, "../../..");
const ROOT = join(REPO, "packages/web/src");

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx$/.test(path) && !/\.test\./.test(path)) out.push(path);
    }
  };
  walk(dir);
  return out;
}

const HEADER = /<(Raft)?SidebarSectionHeader\b[^>]*>([\s\S]*?)<\/(?:Raft)?SidebarSectionHeader>/g;
const TITLE = /<(SidebarSectionToggle|SidebarSectionDisclosure)\b[\s\S]*?<\/\1>/g;
// What renders a control: the part itself, the sort menu, or a render helper.
const CONTROL = /<SidebarSectionControl\b|<SidebarSortMenu\b|<Button\b|<\w*Trigger\b|\brender\w*\(/g;

/** What is wrong with each section header in `source`, if anything. */
export function headerViolations(source: string): string[] {
  const found: string[] = [];
  for (const header of source.matchAll(HEADER)) {
    const rest = header[2].replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(TITLE, "");
    if (/<(div|span)\b/.test(rest)) found.push("a wrapper of our own around the controls");
    const open = rest.search(/<SidebarSectionControls\b[^>]*>/);
    const close = rest.lastIndexOf("</SidebarSectionControls>");
    // Controls is placed by Trailing (absolute, right-0), so it must sit inside one.
    if (open !== -1) {
      const trailing = rest.search(/<SidebarSectionTrailing\b[^>]*>/);
      const trailingEnd = rest.lastIndexOf("</SidebarSectionTrailing>");
      if (trailing === -1 || trailing > open || trailingEnd < close) found.push("SidebarSectionControls outside SidebarSectionTrailing");
    }
    for (const control of rest.matchAll(CONTROL)) {
      const at = control.index ?? 0;
      if (open === -1 || at < open || at > close) found.push(`a control outside SidebarSectionControls: ${control[0]}`);
    }
  }
  return found;
}

test("the guard sees a hand-made wrapper and a bare control, and passes the design system's parts", () => {
  const toggle = "<SidebarSectionToggle sectionKey=\"a\"><Chevron />Channels</SidebarSectionToggle>";
  assert.deepEqual(
    headerViolations(`<SidebarSectionHeader>${toggle}<div className="flex shrink-0 items-center gap-1">{renderSortMenu("a")}</div></SidebarSectionHeader>`),
    ["a wrapper of our own around the controls", "a control outside SidebarSectionControls: renderSortMenu("],
  );
  assert.deepEqual(
    headerViolations(`<RaftSidebarSectionHeader>${toggle}<SidebarSectionControl aria-label="Add" /></RaftSidebarSectionHeader>`),
    ["a control outside SidebarSectionControls: <SidebarSectionControl"],
  );
  assert.deepEqual(
    headerViolations(`<SidebarSectionHeader>${toggle}<SidebarSectionTrailing><SidebarSectionControls>{renderSortMenu("a")}<SidebarSectionControl /></SidebarSectionControls></SidebarSectionTrailing></SidebarSectionHeader>`),
    [],
  );
  assert.deepEqual(headerViolations(`<RaftSidebarSectionHeader onContextMenu={x}>{children}</RaftSidebarSectionHeader>`), []);
  // Controls with props still counts as the part, but it needs Trailing around it.
  assert.deepEqual(
    headerViolations(`<SidebarSectionHeader>${toggle}<SidebarSectionControls data-x="1"><SidebarSectionControl /></SidebarSectionControls></SidebarSectionHeader>`),
    ["SidebarSectionControls outside SidebarSectionTrailing"],
  );
  // A bare Button or a menu trigger in the header is a control too.
  assert.deepEqual(
    headerViolations(`<SidebarSectionHeader>${toggle}<DropdownMenuTrigger /><Button /></SidebarSectionHeader>`),
    ["a control outside SidebarSectionControls: <DropdownMenuTrigger", "a control outside SidebarSectionControls: <Button"],
  );
});

test("every sidebar section header puts its controls in SidebarSectionTrailing > SidebarSectionControls", () => {
  const found: string[] = [];
  let headers = 0;
  for (const path of files(ROOT)) {
    const source = readFileSync(path, "utf8");
    headers += [...source.matchAll(HEADER)].length;
    for (const violation of headerViolations(source)) found.push(`${relative(REPO, path)}: ${violation}`);
  }
  assert.ok(headers > 0, "found no sidebar section headers: the scan no longer matches the source");
  assert.deepEqual(found, []);
});
