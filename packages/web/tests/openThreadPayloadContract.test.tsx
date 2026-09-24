import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const readSource = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");

const normalized = (source: string) => source.replace(/\/\/ Stryker[^\n]*/g, "").replace(/\s+/g, " ");

const snippetPattern = (snippet: string) =>
  new RegExp(snippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"), "g");

function assertSourceIncludes(sourcePath: string, snippets: string[]) {
  const source = normalized(readSource(sourcePath));
  for (const snippet of snippets) {
    assert.match(source, snippetPattern(snippet));
  }
}

function assertSourceOccurrenceCount(sourcePath: string, snippet: string, expectedCount: number) {
  const source = normalized(readSource(sourcePath));
  const matches = source.match(snippetPattern(snippet)) ?? [];
  assert.equal(matches.length, expectedCount, `${sourcePath} should contain ${expectedCount} copy/copies of ${snippet}`);
}

describe("openThread payload contract", () => {
  it("keeps thread opening call sites wired with parent and focus payloads", () => {
    assertSourceIncludes("components/layout/rightPanelUrlSync.ts", [
      `parentChannelId: channelId,
        parentMessageId: messageId,
        focusedMessageId: threadFocusedMessageId`,
    ]);

    assertSourceIncludes("components/message/MessageItem.tsx", [
      `parentChannelId: chId, parentMessageId: message.id`,
      `parentChannelId: chId,
        parentMessageId: message.id,
        focusedMessageId: firstUnreadThreadMessageId`,
      `parentChannelId: hostSource.channelId,
        parentMessageId: hostMessageId,
        focusedMessageId: hostMessageId`,
      `parentChannelId: hostSource.channelId,
        parentMessageId: hostSource.parentMessageId,
        focusedMessageId: hostMessageId`,
      `...threadTarget,
        focusedMessageId: intent.focusedMessageId ?? threadTarget.focusedMessageId`,
      `parentChannelId: permalink.channelId,
        parentMessageId: permalink.threadParentMessageId,
        focusedMessageId: permalink.messageId`,
      `parentChannelId: task.channelId, parentMessageId: task.messageId`,
    ]);

    assertSourceIncludes("components/saved/SavedPanel.tsx", [
      `parentChannelId: entry.parentChannelId,
        parentMessageId: entry.parentMessageId,
        focusedMessageId: entry.messageId`,
    ]);

    assertSourceOccurrenceCount("components/search/MessageSearchPage.tsx",
      `parentChannelId: result.parentChannelId,
        parentMessageId: result.parentMessageId,
        focusedMessageId: result.id`,
      1,
    );

    assertSourceIncludes("components/task/TasksPanel.tsx", [
      `parentChannelId: task.channelId, parentMessageId: task.messageId`,
    ]);

    assertSourceIncludes("components/task/TasksPanel.tsx", [
      `parentChannelId: task.channelId, parentMessageId: task.messageId`,
    ]);

    assertSourceIncludes("components/thread/ThreadsInbox.tsx", [
      `parentChannelId: item.parentChannelId,
        parentMessageId: item.parentMessageId,
        focusedMessageId: targetMessageId,
        initialThreadChannelId: item.threadChannelId`,
    ]);

    assertSourceIncludes("store/messageStore.ts", [
      `parentChannelId: canonicalTarget.channelId,
        parentMessageId: canonicalTarget.threadParentMessageId,
        focusedMessageId: canonicalTarget.messageId`,
    ]);

    assertSourceIncludes("store/threadStore.ts", [
      `serverSlug: openServerSlug ?? undefined,
        parentChannelId: openParentChannelId,
        parentMessageId: openParentMessageId,
        threadChannelId: openThreadChannelId,
        focusedMessageId`,
    ]);

    assertSourceIncludes("utils/refTarget.ts", [
      `serverSlug: target.serverSlug,
        parentChannelId: target.parentChannelId,
        parentMessageId: target.parentMessageId,
        threadChannelId: target.threadChannelId,
        focusedMessageId: target.focusedMessageId`,
    ]);
  });

  it("keeps ref navigation forwarding typed openThread requests", () => {
    assertSourceIncludes("hooks/useRefNavigation.ts", [
      `openThread(request)`,
    ]);
  });
});
