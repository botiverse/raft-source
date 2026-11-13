import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { isTestPath } from "../scripts/testLocations";

/**
 * Stored-channel lookup ratchet (#proj-chat:30a58e4d).
 *
 * The channel store keeps conversations in three slices: `channels`,
 * `dmChannels` and `loungeChannels` (Agent Lounges, which never enter
 * `channels`). Looking a conversation up by id in `channels` alone misses a
 * Lounge (and a DM), and the caller then treats it as a channel it doesn't
 * know: a Lounge's thread lost its reply composer that way. Outside the
 * store, a lookup by id goes through `findStoredChannel` /
 * `useStoredChannel` (store/storedChannel.ts, store/useStoredChannel.ts),
 * which read every slice.
 *
 * The files below keep a by-id lookup on `channels` on purpose, each with
 * why: the question is about a regular channel only (joint, conversion, add
 * members, edit), the list is not the store's (public page readback), or
 * the list was built by the caller. The counts are exact: a new lookup fails
 * here, and one removed means the entry shrinks with it.
 */

const srcRoot = resolve(import.meta.dirname, "../src");
const packageRoot = resolve(import.meta.dirname, "..");

const ALLOWED: Readonly<Record<string, readonly [count: number, reason: string]>> = {
  "components/actions/actionCardEntities.ts": [1, "an action card's #channel ref names a regular channel (DMs and threads excluded in the same test)"],
  "components/channel/AddExternalMemberDialog.tsx": [1, "external members join a regular channel; a Lounge takes none"],
  "components/channel/AddMembersDialog.tsx": [1, "members are added to a regular channel; a Lounge takes none"],
  "components/channel/LeaveChannelConfirmDialog.tsx": [1, "picks the leave wording by a regular channel's kind (public / private / joint)"],
  "components/channel/useConversationSidebarSection.ts": [1, "the sidebar section of a channel row; a Lounge's sheet has no section select"],
  "components/layout/sidebarSort.ts": [1, "sorts the caller's channel list (#all first)"],
  "components/message/MessageItem.tsx": [1, "the joint-surface test: asks only whether the conversation is joint; a DM or Lounge never is"],
  "components/task/TaskConversationDialog.tsx": [1, "asks only whether the task's channel is joint; a DM or Lounge never is"],
  "components/thread/inboxChannelFilter.ts": [1, "a pure label helper over the caller's lists, finding a DM parent's peer; its callers (InboxRow, InboxContextMenu) name a Lounge before calling it"],
  "features/channel/EditChannelDialog.tsx": [1, "edits a regular channel; a Lounge can't be renamed or edited"],
  "features/search/SearchFilterBar.tsx": [1, "labels a channel filter picked from its own options (channels and DMs)"],
  "features/search/useSearchFilters.ts": [1, "labels the channel filter's own options, all from `channels`"],
  "features/sidebar/hooks/useSidebarDnd.ts": [1, "drags a channel row; a Lounge row is not draggable (its entry is read from loungeChannels)"],
  "features/sidebar/hooks/useSidebarMenuActions.ts": [2, "a channel row's menu and move; a Lounge row has its own `lounge` menu (from loungeChannels) and no move"],
  "features/thread/ReadOnlyThreadPanel.tsx": [1, "the public page's readback list, not the store"],
  "hooks/useChannelConversionState.ts": [2, "public / private conversion of a regular channel; a Lounge can't be converted"],
  "pages/PublicServerPage.tsx": [2, "the public page's readback list, not the store"],
  "raftbench/RaftBenchPage.tsx": [1, "the RaftBench service channel, a regular channel"],
};

/**
 * `channels.find((c) => c.id === …)` and the same with `some` / `findIndex`,
 * on a `channels` list (`state.channels`, `s.channels`, a local `channels`)
 * or a list merged from the slices (`navigableChannels`): with a typed
 * parameter (`(c: Channel) =>`), and either way round (`… === c.id`). Not
 * `dmChannels`, `loungeChannels` or any other list.
 */
const BY_ID_LOOKUP = /\b(?:channels|navigableChannels)\??\s*\.\s*(?:find|some|findIndex|findLast)\(\s*\(?\s*(\w+)\s*(?::\s*[\w.<>[\]]+\s*)?\)?\s*=>\s*(?:\1\.id\s*===|[\w.?]+\s*===\s*\1\.id\b)/g;

function countByIdChannelLookups(source: string): number {
  return [...source.matchAll(BY_ID_LOOKUP)].length;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

test("CONTROL: the scanner flags a by-id lookup on `channels` and nothing else", () => {
  assert.equal(countByIdChannelLookups("channels.find((c) => c.id === id)"), 1);
  assert.equal(countByIdChannelLookups("state.channels.find((channel) => channel.id === id)"), 1);
  assert.equal(countByIdChannelLookups("s.channels.some(\n  (entry) =>\n    entry.id === id && entry.type === \"joint\")"), 1);
  assert.equal(countByIdChannelLookups("channels.find(c => c.id === id)"), 1);
  assert.equal(countByIdChannelLookups("channels.find((c: Channel) => c.id === id)"), 1, "a typed parameter");
  assert.equal(countByIdChannelLookups("state.channels.find((c) => id === c.id)"), 1, "the id first");
  assert.equal(countByIdChannelLookups("s.channels.some((c: Channel) => item.channelId === c.id)"), 1);
  assert.equal(countByIdChannelLookups("navigableChannels.find((channel) => channel.id === id)"), 1, "a merged list");
  assert.equal(countByIdChannelLookups("channels.find((c) => c.name === name && c.id !== id)"), 0);
  assert.equal(countByIdChannelLookups("dmChannels.find((c) => c.id === id)"), 0);
  assert.equal(countByIdChannelLookups("loungeChannels?.find((c) => c.id === id)"), 0);
  assert.equal(countByIdChannelLookups("channels.find((c) => c.name === \"all\")"), 0);
  assert.equal(countByIdChannelLookups("channels.filter((c) => c.id !== id)"), 0);
  assert.equal(countByIdChannelLookups("findStoredChannel(state, id)"), 0);
});

test("by-id lookups on the raw `channels` list stay inside the store", () => {
  const found: Record<string, number> = {};
  for (const file of walk(srcRoot)) {
    const rel = relative(srcRoot, file).replaceAll("\\", "/");
    if (rel.startsWith("store/")) continue;
    if (isTestPath(relative(packageRoot, file).replaceAll("\\", "/"))) continue;
    const count = countByIdChannelLookups(readFileSync(file, "utf8"));
    if (count > 0) found[rel] = count;
  }
  const unexpected = Object.entries(found)
    .filter(([rel, count]) => count !== ALLOWED[rel]?.[0])
    .map(([rel, count]) => `${rel}: ${count} (allowed ${ALLOWED[rel]?.[0] ?? 0})`);
  assert.deepEqual(
    unexpected,
    [],
    "Look a conversation up with findStoredChannel / useStoredChannel (store/storedChannel.ts): `channels` alone misses Lounges and DMs. A lookup that must stay is listed in ALLOWED with why.",
  );
  const stale = Object.keys(ALLOWED).filter((rel) => found[rel] === undefined);
  assert.deepEqual(stale, [], "These files no longer look up `channels` by id: drop them from ALLOWED.");
});
