import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("mark read/unread menu actions use conversation bubble icons", () => {
  const threadsInbox = readSource("src/components/thread/ThreadsInbox.tsx");
  const sidebar = readSource("src/components/layout/Sidebar.tsx");

  assert.match(
    threadsInbox,
    /ctxMenu\.item\.unreadCount > 0 \? <MessageSquareCheck size=\{14\} \/> : <MessageSquareDot size=\{14\} \/>/u,
  );
  assert.match(
    sidebar,
    /hasUnread \? <MessageSquareCheck size=\{14\} \/> : <MessageSquareDot size=\{14\} \/>/u,
  );

  assert.doesNotMatch(
    threadsInbox,
    /ctxMenu\.item\.unreadCount > 0 \? <MailOpen size=\{14\} \/> : <Mail size=\{14\} \/>/u,
  );
  assert.doesNotMatch(
    sidebar,
    /hasUnread \? <MailOpen size=\{14\} \/> : <Mail size=\{14\} \/>/u,
  );
});
