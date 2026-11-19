import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

// A link to a page outside Raft that a person reads in a conversation is a content link: it carries the marker
// (`webLinkProps`, features/webPreview/webLinkRouting.ts) so the link router decides where it opens (How web links
// open, the first-time question, Open Beside). The marker is opt-in, so a new surface can forget it and its links
// would go straight to the system browser again (#proj-workspace:#293: App link chips did).
//
// So in the places conversation content is drawn, every `target="_blank"` anchor is either marked or named in OUTSIDE
// with why it must open outside. A new one fails here: spread `webLinkProps` on it, or state its reason.

const SRC = path.resolve(__dirname, "../src");
const CONTENT = ["components/message", "components/markdown", "components/channel/ChannelDescription.tsx"];
const OUTSIDE = new Map<string, { anchors: number; why: string }>([
  ["components/message/MessageCardBody.tsx", { anchors: 2, why: "a card button opens by its author's `open` rule (beside or a tab), ahead of the router" }],
]);

const ANCHOR = /(?<![[\w])target="_blank"/g;
const MARKED = /webLinkProps\)?\}/g;

function files(entry: string): string[] {
  const full = path.join(SRC, entry);
  if (!statSync(full).isDirectory()) return [entry];
  return readdirSync(full).flatMap((name) => (statSync(path.join(full, name)).isDirectory() ? files(`${entry}/${name}`) : name.endsWith(".tsx") ? [`${entry}/${name}`] : []));
}

test("every new-tab link where conversation content is drawn carries the content-link marker, or says why not", () => {
  const seen = new Set<string>();
  for (const file of CONTENT.flatMap(files)) {
    const code = readFileSync(path.join(SRC, file), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
    const anchors = code.match(ANCHOR)?.length ?? 0;
    if (anchors === 0) continue;
    const marked = code.match(MARKED)?.length ?? 0;
    const outside = OUTSIDE.get(file)?.anchors ?? 0;
    if (outside > 0) seen.add(file);
    assert.equal(marked + outside, anchors, `${file}: ${anchors} target="_blank" anchor(s), ${marked} marked with webLinkProps, ${outside} named in OUTSIDE`);
  }
  assert.deepEqual([...OUTSIDE.keys()].filter((file) => !seen.has(file)), [], "OUTSIDE names a file with no such anchor left");
});
