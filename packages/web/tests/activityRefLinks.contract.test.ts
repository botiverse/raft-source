import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(repoRoot, p), "utf8");

test("DM ref regexes are exported alongside the channel ones", () => {
  const src = read("src/utils/messageReferencePatterns.ts");
  const shared = read("../shared/src/raftRefs.ts");
  assert.match(src, /export function createDmThreadRefRegex\(\): RegExp/);
  assert.match(src, /export function createDmRefRegex\(\): RegExp/);
  assert.match(src, /createRaftDmThreadRefRegex/);
  assert.match(src, /createRaftDmRefRegex/);
  assert.match(shared, /export function createRaftDmThreadRefRegex\(\): RegExp/);
  assert.match(shared, /export function createRaftDmRefRegex\(\): RegExp/);
  assert.match(shared, /dm:@\(\$\{RAFT_REF_DM_PEER_PATTERN\}\)/);
});

test("ref grammar has a single source — activity SCAN reuses the exported constants", () => {
  const patterns = read("src/utils/messageReferencePatterns.ts");
  const shared = read("../shared/src/raftRefs.ts");
  // The three grammar fragments are re-exported from @botiverse/raft-shared as the
  // one source of truth for web renderers.
  assert.match(patterns, /export const CHANNEL_REF_NAME_PATTERN =/);
  assert.match(patterns, /export const THREAD_SHORT_ID_PATTERN =/);
  assert.match(patterns, /export const DM_REF_PEER_PATTERN =/);
  assert.match(patterns, /RAFT_REF_CHANNEL_NAME_PATTERN/);
  assert.match(patterns, /RAFT_REF_THREAD_SHORT_ID_PATTERN/);
  assert.match(patterns, /RAFT_REF_DM_PEER_PATTERN/);
  // Factories compose in the shared layer from the constants, not an inline
  // shortid literal in the web wrapper.
  assert.match(shared, /:\(\$\{RAFT_REF_THREAD_SHORT_ID_PATTERN\}\)/);

  const refText = read("src/components/agent/RefText.tsx");
  // Activity tokenizer builds SCAN from the SAME constants…
  assert.match(
    refText,
    /import \{\s*CHANNEL_REF_NAME_PATTERN,\s*THREAD_SHORT_ID_PATTERN,\s*DM_REF_PEER_PATTERN,?\s*\} from "\.\.\/\.\.\/utils\/messageReferencePatterns"/,
  );
  assert.match(refText, /new RegExp\(\s*`#\(\$\{CHANNEL_REF_NAME_PATTERN\}\)/);
  // …and must NOT re-spell the char classes (drift guard).
  assert.doesNotMatch(refText, /\[\\p\{L\}\\p\{N\}_-\]/);
  assert.doesNotMatch(refText, /\[0-9a-f\]\{6,8\}/);
});

test("refTarget is a pure shared layer — no React, resolve is sync/side-effect-free", () => {
  const src = read("src/utils/refTarget.ts");
  // Shared seam must not pull React (locked with @Bugen).
  assert.doesNotMatch(src, /from "react"/);
  assert.doesNotMatch(src, /from "react\//);
  // resolveRef itself must be a plain (sync) function — async work lives in
  // the navigate() closure only.
  assert.match(src, /export function resolveRef\(parts: RefParts, ctx: RefNavContext\): ResolvedRef/);
  assert.doesNotMatch(src, /export async function resolveRef\b/);
  // Thread-parent backend resolution is deferred into navigateThread (the
  // click-time closure), never eager at resolve.
  assert.match(src, /async function navigateThread\(/);
  assert.match(src, /resolveThreadTargetByShortId\(/);
  assert.match(src, /loadContext: ctx\.loadThreadContext/);
});

test("thread ref fallback canonicalizes reply ids to parent thread plus focus", () => {
  const nav = read("src/utils/threadRefNavigation.ts");
  const refTarget = read("src/utils/refTarget.ts");
  const messageItem = read("src/components/message/MessageItem.tsx");

  assert.match(nav, /canonicalTarget\?\.kind === "thread"/);
  assert.match(nav, /parentMessageId: context\.canonicalTarget\.threadParentMessageId/);
  assert.match(nav, /focusedMessageId: context\.targetMessageId/);
  assert.match(refTarget, /ctx\.openThread\(\{\s*serverSlug: target\.serverSlug,\s*parentChannelId: target\.parentChannelId,\s*parentMessageId: target\.parentMessageId,\s*threadChannelId: target\.threadChannelId,\s*focusedMessageId: target\.focusedMessageId,\s*\}\)/);
  assert.match(
    messageItem,
    /openThread\(\{\s*\.\.\.threadTarget,\s*focusedMessageId: intent\.focusedMessageId \?\? threadTarget\.focusedMessageId,\s*\}\)/,
  );
});

test("tokenizer stays activity-local (NOT in the shared util)", () => {
  const refText = read("src/components/agent/RefText.tsx");
  assert.match(refText, /export function linkifyRefs\(text: string, ctx: RefNavContext\): ReactNode\[\]/);
  assert.match(refText, /export function RefText\(/);
  // Shared util must not contain a string→ReactNode tokenizer.
  const util = read("src/utils/refTarget.ts");
  assert.doesNotMatch(util, /ReactNode/);
});

test("ref chip reuses chat affordance recipe; no spinner, cursor stays default", () => {
  const src = read("src/components/agent/RefText.tsx");
  assert.match(src, /import \{ MSG_REF_CHIP \} from "\.\.\/message\/messageRefChip";/);
  assert.match(src, /className=\{`\$\{MSG_REF_CHIP\} cursor-default text-black/);
  // Same tint recipe family as MessageItem refs (thread=cyan, channel/dm=pink).
  assert.match(src, /bg-brutal-cyan\/30 hover:bg-brutal-cyan\/60/);
  assert.match(src, /bg-brutal-pink\/30 hover:bg-brutal-pink\/60/);
  const sharedChip = read("src/components/message/messageRefChip.ts");
  assert.match(sharedChip, /inline-block/);
  assert.match(sharedChip, /align-bottom/);
  assert.match(sharedChip, /border border-black/);
  assert.match(sharedChip, /leading-\[1\.3em\]/);
  // Cursor contract: refs are app chrome — never the link hand.
  assert.match(src, /cursor-default/);
  assert.doesNotMatch(src, /cursor-pointer/);
  // No spinner in the mono activity row (locked with @Bugen) — busy = dim +
  // non-interactive instead.
  assert.doesNotMatch(src, /Spinner/);
  assert.match(src, /pointer-events-none opacity-60/);
  // Unresolvable refs fall back to verbatim source text, never a dead link.
  assert.match(src, /out\.push\(m\[0\]\)/);
});

test("AgentActivityLog linkifies ONLY structured-metadata entries, not free-form text", () => {
  // Scope locked by xxchan #proj-uiux:2921feaf (task #266 follow-up): ref
  // linkification is meaningful only on the structured-metadata entry kinds —
  // SlockAction (slock-cli `target:` metadata), System, and Status — where a
  // #channel / thread / dm token is a real navigation target. Output (Text),
  // Thinking, and Tool are free-form agent text where `#x` is incidental —
  // linkifying them is noise.
  const src = read("src/components/agent/AgentActivityLog.tsx");
  assert.match(src, /import \{ RefText, ThreadRefNoticeProvider \} from "\.\/RefText";/);

  // Exactly THREE <RefText> usages: SlockActionEntry, SystemEntry, StatusEntry.
  const refTextUsages = src.match(/<RefText\b/g) ?? [];
  assert.equal(
    refTextUsages.length,
    3,
    "RefText must be used exactly 3x (SlockAction + System + Status)",
  );

  // SlockActionEntry — the function carrying the bg-blue-300 slock-action dot.
  const slockAction = src.match(/function SlockActionEntry\([\s\S]*?\n\}\n/);
  assert.ok(slockAction, "SlockActionEntry not found");
  assert.match(slockAction[0], /bg-blue-300/);
  assert.match(slockAction[0], /<RefText text=\{text\} \/>/);

  // The structured-metadata entries route through RefText.
  const systemEntry = src.match(/function SystemEntry\([\s\S]*?\n\}\n/);
  assert.ok(systemEntry, "SystemEntry not found");
  assert.match(systemEntry[0], /<RefText text=\{text\} \/>/);

  for (const fn of ["StatusEntry"]) {
    const m = src.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}\\n`));
    assert.ok(m, `${fn} not found`);
    assert.match(m[0], /<RefText\b/, `${fn} must use RefText (structured metadata)`);
  }

  // The free-form entries must NOT route through RefText.
  for (const fn of ["ThinkingEntry", "TextEntry", "ToolStartEntry"]) {
    const m = src.match(new RegExp(`function ${fn}\\([\\s\\S]*?\\n\\}\\n`));
    assert.ok(m, `${fn} not found`);
    assert.doesNotMatch(m[0], /<RefText\b/, `${fn} must NOT use RefText (free-form text)`);
  }

  // Thread-unavailable notice still wired through the provider.
  assert.match(src, /<ThreadRefNoticeProvider onNotice=\{showThreadRefNotice\}>/);
});
