import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createChannelRefRegex, createChannelThreadRefRegex } from "../src/utils/messageReferencePatterns";

test("channel refs support CJK channel names", () => {
  const matches = Array.from("go to #对话流专修 and #android-artifacts".matchAll(createChannelRefRegex()));

  assert.deepEqual(matches.map((match) => match[1]), ["对话流专修", "android-artifacts"]);
});

test("channel thread refs support CJK channel names", () => {
  const matches = Array.from("see #对话流专修:abc123 and #product:deadbee".matchAll(createChannelThreadRefRegex()));

  assert.deepEqual(matches.map((match) => [match[1], match[2]]), [
    ["对话流专修", "abc123"],
    ["product", "deadbee"],
  ]);
});

test("MessageItem bare refs use shared Slock Ref scanners", () => {
  const source = readFileSync(new URL("../src/components/message/MessageItem.tsx", import.meta.url), "utf8");
  const shared = readFileSync(new URL("../../shared/src/raftRefs.ts", import.meta.url), "utf8");

  for (const factory of [
    "createRaftUserRefRegex",
    "createRaftChannelThreadRefRegex",
    "createRaftDmThreadRefRegex",
    "createRaftBareTaskRefRegex",
    "createRaftChannelRefRegex",
    "createRaftMessageRefRegex",
  ]) {
    assert.match(source, new RegExp(`${factory}\\(\\)`), `MessageItem must call ${factory}`);
    assert.match(shared, new RegExp(`export function ${factory}\\(\\): RegExp`), `${factory} must live in shared`);
  }

  assert.doesNotMatch(source, /@\\\(\[\\p\{L\}\\p\{N\}_-\]\+\)/);
  assert.doesNotMatch(source, /dm:@\(\[\\w-\]\+\):\(\[\\da-f\]\{6,8\}\)/);
  assert.doesNotMatch(source, /\(\^\|\[\^\\w\/\]\)\(\?:\(task\\s\+\)\)\?#\(\\d\+\)\\b/);
  assert.doesNotMatch(source, /#\(\[\\w-\]\+\)/);
});

test("MessageItem resolves bare mention labels from the canonical identity directory", () => {
  const source = readFileSync(new URL("../src/components/message/MessageItem.tsx", import.meta.url), "utf8");

  assert.match(source, /const safeName = name\.replace/);
  assert.match(source, /data-mention="\$\{safeName\}"/);
  assert.match(source, /const visibleLabel = resolvedMention\?\.displayName/);
  assert.match(source, /escapeMessageHtmlText\(visibleLabel\)/);
  assert.match(source, /resolveMentionByIdentity\(entry\.type, entry\.id\)/);
  assert.match(source, /: `@\$\{name\}`/);
  assert.doesNotMatch(source, /pendingLabel=/);
});

test("all message reference chips share one height box (MSG_REF_CHIP)", () => {
  const chipConst = readFileSync(
    new URL("../src/components/message/messageRefChip.ts", import.meta.url),
    "utf8",
  );
  const source = readFileSync(new URL("../src/components/message/MessageItem.tsx", import.meta.url), "utf8");
  const mention = readFileSync(
    new URL("../src/components/message/MentionLink.tsx", import.meta.url),
    "utf8",
  );
  const attachmentComments = readFileSync(
    new URL("../src/components/message/AttachmentCommentsPanel.tsx", import.meta.url),
    "utf8",
  );
  const attachmentCommentRefChip = readFileSync(
    new URL("../src/components/message/AttachmentCommentRefChip.tsx", import.meta.url),
    "utf8",
  );
  const referenceChip = readFileSync(
    new URL("../src/components/message/ReferenceChip.tsx", import.meta.url),
    "utf8",
  );
  const taskRefSection = source.slice(
    source.indexOf("const taskRef"),
    source.indexOf("const raftPermalink"),
  );

  // Single source of truth lives in its OWN module so MentionLink can import
  // the same constant (Huarong review #proj-message:ca65d96d found the
  // self-mention chip drifting on its own leading box when the const
  // was MessageItem-local). Every chip composes it → "all chips one height"
  // is structurally guaranteed (stdrc task #28 msg=dee00ea3). The box uses
  // relative font size + relative line-height keeps the token one step smaller
  // than the message body while still following the body font-size preference;
  // horizontal padding stays, vertical padding is explicitly zero. No `cursor`
  // in the shared box: in-message refs are app chrome
  // and stay on the arrow cursor (stdrc task #28 msg=ca65d96d) — each in-app
  // chip appends `cursor-default` explicitly; only the trailing external-URL
  // <a target="_blank"> keeps the browser link-hand. Long labels still need a
  // hard max-width + overflow clipping envelope; otherwise comment labels can
  // paint outside the chip border in narrow columns.
  assert.match(
    chipConst,
    /export const MSG_REF_CHIP =\s*"inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom border border-black px-1 py-0 \[font-size:0\.875em\] font-bold leading-\[1\.3em\] select-text"/,
  );
  assert.doesNotMatch(chipConst, /text-sm font-bold leading-\[21px\]/);
  assert.match(chipConst, /whitespace-nowrap.*task #16/s);
  assert.match(chipConst, /max-width \+[\s\S]*overflow clipping/);

  // MessageItem and MentionLink still import the constant and inline the box
  // for the chips that are NOT the shared ReferenceChip (thread/#channel/task).
  assert.match(source, /import \{ MSG_REF_CHIP \} from "\.\/messageRefChip"/);
  assert.match(mention, /import \{ MSG_REF_CHIP \} from "\.\/messageRefChip"/);

  // The permalink chip and the comment-ref chip now render through the shared
  // ReferenceChip, which is where the MSG_REF_CHIP box now lives for them — so
  // the "all chips one height" guarantee is repointed through ReferenceChip
  // rather than re-inlined at each call site. ReferenceChip imports the one
  // constant and composes it as the box (with the shared inline-flex layout).
  assert.match(referenceChip, /import \{ MSG_REF_CHIP \} from "\.\/messageRefChip"/);
  assert.match(referenceChip, /className=\{`\$\{MSG_REF_CHIP\} inline-flex max-w-full cursor-default items-center gap-1 \$\{colorClass\}`\}/);

  // MessageItem chip variants that still inline the box compose it directly.
  assert.match(source, /data-thread-ref[\s\S]*?className=\{`\$\{MSG_REF_CHIP\} bg-brutal-cyan\/30/);
  assert.match(source, /dataChannel[\s\S]*?className=\{`\$\{MSG_REF_CHIP\} bg-brutal-pink\/30 text-black cursor-default/);
  assert.match(source, /dataTaskRef[\s\S]*?className=\{`\$\{MSG_REF_CHIP\} bg-soft-signal\/40 text-black cursor-default/);
  assert.match(source, /data-thread-ref[\s\S]*?cursor-wait opacity-80[\s\S]*?cursor-default hover:bg-brutal-cyan\/60/);

  // The permalink chip renders through ReferenceChip with the Link icon and the
  // in/out-of-server soft-signal color, plus the non-bold trailing "msg" badge.
  assert.match(source, /raftPermalink[\s\S]*?<ReferenceChip[\s\S]*?icon=\{Link\}/);
  assert.match(source, /raftPermalink[\s\S]*?colorClass=\{[\s\S]*?bg-soft-signal\/40 text-black hover:bg-soft-signal/);
  assert.match(source, /text-\[10px\] font-normal leading-none text-black\/50/);

  // Comment ref chips render through ReferenceChip with the MessageSquare icon
  // and the stone color (distinct from the permalink's soft-signal, per stdrc).
  // The anchor label is carried inside the single `label` string (rendered in
  // ReferenceChip's one truncating span), not in a separate shrink-0 trailing
  // span that can overflow the chip.
  assert.match(attachmentCommentRefChip, /<ReferenceChip[\s\S]*?icon=\{MessageSquare\}/);
  assert.match(attachmentCommentRefChip, /data-message-affordance="attachment-comment-ref-chip"/);
  assert.match(attachmentCommentRefChip, /colorClass="bg-brutal-stone\/25 text-black/);
  assert.match(
    attachmentCommentRefChip,
    /const detail = `\$\{commentRef\.filename\}\$\{commentRef\.anchorLabel \? ` · \$\{commentRef\.anchorLabel\}` : ""\}`/,
  );
  assert.match(attachmentCommentRefChip, /const label = formatMessage\(\{ id: "message\.attachment\.rePrefix" \}, \{ name: detail \}\)/);
  assert.match(referenceChip, /<span className="min-w-0 truncate">\{label\}<\/span>/);
  assert.doesNotMatch(attachmentCommentRefChip, /commentRef\.anchorLabel \? <span className="shrink-0 whitespace-nowrap">/);
  assert.match(attachmentComments, /data-message-affordance="attachment-comment-anchor"[\s\S]*?className="[^"]*overflow-hidden[^"]*"[\s\S]*?<span className="min-w-0 truncate">/);
  assert.match(attachmentComments, /data-message-affordance="attachment-comment-pending-anchor"[\s\S]*?className="[^"]*overflow-hidden[^"]*"[\s\S]*?<span className="min-w-0 truncate">/);

  // MentionLink self-mention chip composes the SAME box (Huarong blocker).
  assert.match(mention, /isSelfMention\s*\?\s*`\$\{MSG_REF_CHIP\} bg-soft-signal hover:bg-soft-signal\/80`/);

  // No chip (in either renderer) may re-inline the old box or a link-hand cursor.
  assert.doesNotMatch(source, /inline-block border border-black[^"`]*leading-\[21px\]/);
  assert.doesNotMatch(mention, /inline-block border border-black[^"`]*leading-\[21px\]/);
  assert.doesNotMatch(attachmentCommentRefChip, /inline-block border border-black[^"`]*leading-\[21px\]/);
  assert.doesNotMatch(source, /cursor-pointer/);
  assert.doesNotMatch(mention, /cursor-pointer/);
  assert.doesNotMatch(attachmentCommentRefChip, /cursor-pointer/);
  assert.doesNotMatch(source, /dataTaskRef[\s\S]*?bg-brutal-lime/);
  assert.doesNotMatch(taskRefSection, /inline-flex/);
  assert.doesNotMatch(taskRefSection, /font-mono text-sm/);
  assert.doesNotMatch(taskRefSection, /py-0\.5/);
  assert.doesNotMatch(taskRefSection, /leading-none/);
  assert.doesNotMatch(taskRefSection, /border-2/);
  assert.doesNotMatch(source, /inline-flex h-5 items-center/);
});
