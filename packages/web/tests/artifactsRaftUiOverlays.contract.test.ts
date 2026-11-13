import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// The Artifacts app builds its overlays from raft-ui (#proj-workspace:#65):
// Popover, PreviewCard, DropdownMenu, Dialog, Drawer and Tooltip, which give
// the role, the focus handling, the placement and the DS padding. A hand-made
// one (a div given role="dialog" / "menu" / "tooltip" / "listbox", a portal of
// its own, a floating surface positioned by hand, a native title tooltip)
// fails here, as does a popover whose text sits straight on the panel's edge
// instead of in its body part (16px in).
//
// The rest of the parts it used to draw itself are raft-ui's too (raft-ui
// 0.40.0), and fail here if drawn again: a control's own focus ring (the
// share dialog's conversation rows, the presence faces, the anchor line: now
// the inline Combobox, AvatarGroupButton and CommentCardMeta as a button), a
// hairline drawn between rows (SearchEntityResult draws it, when the rows are
// siblings) and a rail beside replies (DS Comment: a reply is one more
// CommentEntry in the card).
//
// KNOWN lists what raft-ui can't do yet, with why; each entry must still
// match, so a fixed one is dropped from here.
//
// A heuristic over the source text, not a JSX parse. It doesn't see: an
// attribute holding `>` (an arrow function) before the one it looks for; a
// role chosen by an expression (role={open ? "dialog" : …}); popover text
// given as a bare expression ({who}) instead of an element. Review catches
// those.

const ROOT = path.resolve(__dirname, "../src/apps/artifacts");

const RULES: Array<[string, RegExp]> = [
  ["hand-rolled overlay role", /\brole=["{]["']?(?:dialog|alertdialog|menu|menubar|menuitem|menuitemradio|menuitemcheckbox|tooltip|listbox|option|combobox|grid|tab|tablist|radio|radiogroup)\b/g],
  ["own portal", /\bcreatePortal\(/g],
  // A floating surface on a lowercase element: positioned by hand and drawn as a popup.
  ["hand-positioned popup surface", /<[a-z][a-z0-9]*\b[^<>]*?className=(?:"[^"]*\b(?:absolute|fixed)\b[^"]*\b(?:shadow-float|bg-layer-popover)\b[^"]*"|"[^"]*\b(?:shadow-float|bg-layer-popover)\b[^"]*\b(?:absolute|fixed)\b[^"]*")/g],
  // A native tooltip. An iframe's title is its accessible name, not a tooltip.
  ["native title tooltip", /<(?!iframe\b)[a-z][a-z0-9]*\b[^<>]*?\stitle=/g],
  // The panel's text in its body part (or under its header), not on the edge.
  // ({ } is a JSX comment, blanked.)
  ["popover text without PopoverBody", /<PopoverContent\b[^>]*>\s*(?:\{\s*\}\s*)*<(?!PopoverBody\b|PopoverHeader\b)/g],
  ["preview card text without its body", /<PreviewCardContent\b[^>]*>\s*(?:\{\s*\}\s*)*<(?!PreviewCardBody\b|PreviewCardHeader\b)/g],
  // A control drawing its own focus ring: the raft-ui control has one.
  ["own focus ring", /\bfocus(?:-visible)?:(?:shadow-focus|ring-\d)\b/g],
  // A line drawn between rows by hand (`not-first:before:border-t`): the raft-ui row draws it.
  ["hand-drawn row hairline", /\b(?:(?:before|after):border-[tb]|divide-y)\b/g],
  // A rail beside nested content (2px and up; a 1px `border-s` is a region's seam).
  ["hand-drawn rail", /\bborder-[slre]-(?:[2-9]\b|\[\d+px\])/g],
];

/** `file kind` → why raft-ui can't do it yet. */
const KNOWN = new Map<string, string>([
  // Not a popup: the viewer opened from inside a dialog (a task's conversation) takes that dialog's card in place,
  // so it renders into the card it came from. raft-ui has no slot for content a dialog didn't render itself.
  ["ArtifactSideCard.tsx own portal", "the viewer covering the dialog it was opened from (#proj-workspace:#104)"],
  // Not a control raft-ui has: the table's column-resize grip (#proj-workspace:#133, design D21), a focusable separator
  // with its own ring until raft-ui's Table takes it (TODO(raft-ui) in ArtifactsTable.tsx; Kirby upstreams it).
  ["ArtifactsTable.tsx own focus ring", "the table's column-resize grip, a raft-ui gap (#133)"],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx") && !full.includes(".test.")) out.push(full);
  }
  return out;
}

/** The source with comments blanked (kept as spaces, so line numbers hold); `//` after a `:` (a URL) is kept. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, " "));
}

function offences(source: string): string[] {
  const text = code(source);
  return RULES.flatMap(([kind, pattern]) => [...text.matchAll(pattern)].map(() => kind));
}

test("the rules catch what they say, past a JSX comment, and not in comments", () => {
  assert.deepEqual(offences(`<PopoverContent>{/* note */}<p>who</p></PopoverContent>`), ["popover text without PopoverBody"]);
  assert.deepEqual(offences(`<PopoverContent className="w-72">\n  {/* DS */}\n  <PopoverBody>who</PopoverBody></PopoverContent>`), []);
  assert.deepEqual(offences(`<div role="dialog" className="p-4" />`), ["hand-rolled overlay role"]);
  assert.deepEqual(offences(`<div className="absolute top-8 shadow-float bg-layer-popover" />`), ["hand-positioned popup surface"]);
  assert.deepEqual(offences(`<span title={name}>{name}</span>`), ["native title tooltip"]);
  assert.deepEqual(offences(`<iframe title="Page" src="x" />`), []);
  assert.deepEqual(offences(`// a <div role="dialog"> in a comment\n/* <span title="x"> */`), []);
  assert.deepEqual(offences(`const url = "https://x"; <div role="menu" />`), ["hand-rolled overlay role"]);
  assert.deepEqual(offences(`<div role="option" aria-selected={selected} />`), ["hand-rolled overlay role"]);
  assert.deepEqual(offences(`<button className="rounded-chip outline-none focus-visible:shadow-focus" />`), ["own focus ring"]);
  assert.deepEqual(offences(`<div className="relative not-first:before:absolute not-first:before:border-t not-first:before:border-line-hairline" />`), ["hand-drawn row hairline"]);
  // Split so Tailwind's scan doesn't compile the class (webkitStructuralSelectors bans its output).
  assert.deepEqual(offences(`<ul className="${"divide"}-y" /><li className="after:border-b" />`), ["hand-drawn row hairline", "hand-drawn row hairline"]);
  assert.deepEqual(offences(`<div className="border-e-2" /><div className="border-s-[3px]" />`), ["hand-drawn rail", "hand-drawn rail"]);
  assert.deepEqual(offences(`<button className="focus:shadow-focus" /><button className="focus-visible:ring-2" />`), ["own focus ring", "own focus ring"]);
  assert.deepEqual(offences(`<div role="tab" />`), ["hand-rolled overlay role"]);
  assert.deepEqual(offences(`<div className="flex flex-col gap-2 border-s-2 border-line-hairline ps-3" />`), ["hand-drawn rail"]);
  // A region's 1px seam and a stretched link's ring on its ::after are not these.
  assert.deepEqual(offences(`<aside className="flex border-s border-line-seam" /><a className="after:absolute focus-visible:after:shadow-focus" />`), []);
});

test("apps/artifacts draws its overlays with raft-ui, the text in the DS body parts", () => {
  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    const source = readFileSync(file, "utf8");
    const text = code(source);
    for (const [kind, pattern] of RULES) {
      for (const match of text.matchAll(pattern)) {
        const key = `${rel} ${kind}`;
        seen.add(key);
        if (KNOWN.has(key)) continue;
        const line = text.slice(0, match.index).split("\n").length;
        offenders.push(`${rel}:${line} ${kind}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "compose from raft-ui (Popover + PopoverBody, PreviewCard, DropdownMenu, Dialog, Drawer, Tooltip; an inline Combobox for a list, AvatarGroupButton, CommentCardMeta as a button, sibling SearchEntityResults); a gap goes to raft-ui, with a KNOWN entry until then");
  for (const key of KNOWN.keys()) assert.ok(seen.has(key), `${key} no longer matches: drop it from KNOWN`);
});
