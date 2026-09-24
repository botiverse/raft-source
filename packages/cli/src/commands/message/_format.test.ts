// Snapshot-style tests for agent-facing output format.
// These pin the exact text shape that agents parse — if a test breaks,
// the change is an AX contract change and needs explicit sign-off.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatMessageLine, formatMessages, formatHistory, formatSearchResults, formatTarget } from "./_format.js";
import type { RaftTargetString } from "@botiverse/raft-shared";

// ── Type-level guarantee (enforced by `tsc --noEmit`) ──
// formatTarget's return is the structured wire form, not an opaque string, so a
// dropped `@`/`#` in any of its branches is a compile error, not a bad target.
const _formatTargetIsTyped: RaftTargetString = formatTarget({ channel_type: "channel", channel_name: "general" });
void _formatTargetIsTyped;
// @ts-expect-error — a bare name (missing sigil) is not a valid target string
const _badTarget: RaftTargetString = "general";
void _badTarget;

function extractBareMentionHandles(source: string): string[] {
  return [...source.matchAll(/(^|[^\w])@([A-Za-z0-9][A-Za-z0-9_-]*)/g)].map((match) => match[2]);
}

// ── formatMessages (check) ──────────────────────────────────────────

test("formatMessages: empty list", () => {
  assert.equal(formatMessages([]), "No new inbox messages.");
});

test("formatMessages: single channel message", () => {
  const out = formatMessages([
    {
      channel_type: "channel",
      channel_name: "engineering",
      message_id: "abcd1234efgh5678",
      timestamp: "2026-04-21T06:30:00.000Z",
      sender_type: "human",
      sender_name: "alice",
      sender_description: null,
      content: "ship it",
    },
  ]);
  assert.equal(
    out,
    "[target=#engineering msg=abcd1234 time=2026-04-21 06:30:00Z type=human] @alice: ship it",
  );
});

test("formatMessages: notify-only outsider mention states the reply limitation", () => {
  const out = formatMessages([
    {
      channel_type: "thread",
      channel_name: "thread-abcd1234",
      parent_channel_type: "channel",
      parent_channel_name: "engineering",
      message_id: "abcd1234efgh5678",
      timestamp: "2026-04-21T06:30:00.000Z",
      sender_type: "human",
      sender_name: "alice",
      content: "@outsider please review",
      non_member_mention: true,
    },
  ]);

  assert.match(out, /@alice: @outsider please review/);
  assert.match(out, /If no reply is needed, no action is required\. Otherwise, DM the person who mentioned you or join the channel to participate/);
});

test("formatMessages: DM with attachments", () => {
  const out = formatMessages([
    {
      channel_type: "dm",
      channel_name: "bob",
      message_id: "ff00ff00ff00ff00",
      timestamp: "2026-04-21T09:00:00.000Z",
      sender_type: "agent",
      sender_name: "akko",
      sender_description: "runtime IC",
      content: "here's the log",
      attachments: [
        { id: "att_001", filename: "debug.log" },
        { id: "att_002", filename: "trace.json" },
      ],
    },
  ]);
  assert.equal(
    out,
    '[target=dm:@bob msg=ff00ff00 time=2026-04-21 09:00:00Z type=agent] @akko — runtime IC: here\'s the log [2 attachments: debug.log (id:att_001), trace.json (id:att_002) — use raft attachment view to download]',
  );
});

test("formatMessages: thread message", () => {
  const out = formatMessages([
    {
      channel_type: "thread",
      channel_name: "thread-abcd1234",
      parent_channel_type: "channel",
      parent_channel_name: "slock-cli",
      message_id: "1111222233334444",
      timestamp: "2026-04-21T10:00:00.000Z",
      sender_type: "human",
      sender_name: "xxchan",
      content: "看一下这个 PR",
    },
  ]);
  assert.equal(
    out,
    "[target=#slock-cli:abcd1234 msg=11112222 time=2026-04-21 10:00:00Z type=human] @xxchan: 看一下这个 PR",
  );
});

test("formatMessages: DM thread", () => {
  const out = formatMessages([
    {
      channel_type: "thread",
      channel_name: "thread-deadbeef",
      parent_channel_type: "dm",
      parent_channel_name: "alice",
      message_id: "aabbccdd00112233",
      timestamp: "2026-04-21T11:00:00.000Z",
      sender_type: "human",
      sender_name: "alice",
      content: "followup",
    },
  ]);
  assert.equal(
    out,
    "[target=dm:@alice:deadbeef msg=aabbccdd time=2026-04-21 11:00:00Z type=human] @alice: followup",
  );
});

test("formatMessages: task annotation", () => {
  const out = formatMessages([
    {
      channel_type: "channel",
      channel_name: "engineering",
      message_id: "task123400000000",
      timestamp: "2026-04-21T08:00:00.000Z",
      sender_type: "human",
      sender_name: "bob",
      content: "fix the flaky test",
      task_status: "open",
      task_number: 42,
      task_assignee_id: "agent_akko",
      task_assignee_type: "agent",
      task_assignee_name: "akko",
    },
  ]);
  assert.equal(
    out,
    "[target=#engineering msg=task1234 time=2026-04-21 08:00:00Z type=human] @bob: fix the flaky test [task #42 status=open assignee=@akko]",
  );
});

test("formatMessages: unresolved task assignee never prints opaque id", () => {
  const out = formatMessages([
    {
      channel_type: "channel",
      channel_name: "engineering",
      message_id: "task123400000000",
      timestamp: "2026-04-21T08:00:00.000Z",
      sender_type: "human",
      sender_name: "bob",
      content: "fix the flaky test",
      task_status: "open",
      task_number: 42,
      task_assignee_id: "6e6ef0c5-0da7-4983-a69d-b072a072d355",
      task_assignee_type: "agent",
    },
  ]);
  assert.match(out, /assignee=<unresolved>/);
  assert.doesNotMatch(out, /6e6ef0c5/);
  assert.doesNotMatch(out, /agent:6e6ef0c5/);
});

test("formatMessages: amended task preserves host bytes and renders the current projection", () => {
  const original = "investigate old premise\nall original body stays immutable";
  const out = formatMessages([{
    channel_type: "channel",
    channel_name: "runtime",
    message_id: "9280000000000000",
    timestamp: "2026-08-19T09:00:00.000Z",
    sender_type: "human",
    sender_name: "tenny",
    content: original,
    task_status: "in_progress",
    task_number: 928,
    task_current_projection: {
      title: "current narrowed premise\nwith the latest owner",
      description: null,
      revision: 3,
      superseded: true,
      amended_at: "2026-08-19T09:05:00.000Z",
      amended_by_type: "agent",
      amended_by_name: "cross",
      source: "tasks_current_projection",
    },
  }]);

  assert.match(out, /investigate old premise\nall original body stays immutable \[task #928/);
  assert.match(out, /\[task superseded: current projection rev=3 source=tasks_current_projection actor=@cross time=2026-08-19 09:05:00Z\]/);
  assert.match(out, /Current title: current narrowed premise\nwith the latest owner/);
});

test("formatMessages: third-party event uses concrete agent-event target", () => {
  const out = formatMessages([
    {
      channel_type: "dm",
      channel_name: "third-party-agent-events:agent-123",
      message_id: "eeeeffff00001111",
      timestamp: "2026-04-21T08:30:00.000Z",
      sender_type: "third_party_app",
      sender_name: "task44-demo-third-party",
      sender_description: "Task 44 Demo",
      content: "Third-party event: Demo build event",
      third_party_event: {
        id: "12345678-0000-4000-8000-000000000000",
        kind: "event",
        client_id: "task44-demo-third-party",
        client_name: "Task 44 Demo",
        external_event_id: "build-123",
        payload_hash: "a".repeat(64),
        payload: {
          meeting_title: "Weekly sync",
          join_url: "https://meet.example.test/weekly-sync",
          organizer: "@Ray",
        },
        expires_at: "2026-04-22T08:30:00.000Z",
        source: {
          client_id: "task44-demo-third-party",
          client_name: "Task 44 Demo",
          oauth_client_id: "client-row-123",
          access_token_id_hash: "b".repeat(64),
          resource: "urn:raft:server:server-123:agent-inbound",
        },
      },
    },
  ]);
  assert.equal(
    out,
    `[target=agent-event:12345678 msg=eeeeffff time=2026-04-21 08:30:00Z type=third_party_app] @task44-demo-third-party — Task 44 Demo: kind=event; payload_hash=${"a".repeat(64)}; resource=urn:raft:server:server-123:agent-inbound; access_token_id_hash=${"b".repeat(64)}
Third-party event: Demo build event
payload:
{
  "meeting_title": "Weekly sync",
  "join_url": "https://meet.example.test/weekly-sync",
  "organizer": "user:Ray"
}`,
  );
  assert.doesNotMatch(out, /trust_class|untrusted/i);
  assert.doesNotMatch(out, /treat .* as data|not instructions/i);
  assert.doesNotMatch(out, /@Ray\b/);
});

test("formatMessages: multiple messages preserve order", () => {
  const out = formatMessages([
    {
      channel_type: "channel",
      channel_name: "general",
      message_id: "0000000000000001",
      timestamp: "2026-04-21T01:00:00.000Z",
      sender_type: "human",
      sender_name: "a",
      content: "first",
    },
    {
      channel_type: "channel",
      channel_name: "general",
      message_id: "0000000000000002",
      timestamp: "2026-04-21T02:00:00.000Z",
      sender_type: "human",
      sender_name: "b",
      content: "second",
    },
  ]);
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /\@a: first$/);
  assert.match(lines[1], /\@b: second$/);
});

// ── formatHistory (read) ────────────────────────────────────────────

test("formatHistory: empty channel", () => {
  assert.equal(
    formatHistory("#test", { messages: [] }),
    "No messages in this channel.",
  );
});

test("formatHistory: basic history with last_read_seq", () => {
  const out = formatHistory("#engineering", {
    messages: [
      { seq: 10, id: "aabb0000", createdAt: "2026-04-21T06:00:00.000Z", senderType: "human", senderName: "alice", content: "hello" },
      { seq: 11, id: "aabb0001", createdAt: "2026-04-21T06:01:00.000Z", senderType: "agent", senderName: "akko", senderDescription: "runtime IC", content: "hi back" },
    ],
    last_read_seq: 9,
  });
  assert.equal(
    out,
    [
      'Read window: 2 returned, seq 10-11, oldest to newest. No older. No newer.',
      'Server unread cursor before this read: seq 9. Use raft message read --target "#engineering" --after 9 to browse newer messages.',
      '',
      '[1/2 seq=10 msg=aabb0000 time=2026-04-21 06:00:00Z type=human replyTarget=#engineering:aabb0000] @alice: hello',
      '[2/2 seq=11 msg=aabb0001 time=2026-04-21 06:01:00Z type=agent replyTarget=#engineering:aabb0001] @akko — runtime IC: hi back',
      '',
      'End of window: 2/2 shown.',
    ].join("\n"),
  );
});

test("formatHistory: has_more with default (backward) pagination", () => {
  const out = formatHistory("#general", {
    messages: [
      { seq: 5, id: "id05", createdAt: "2026-04-21T05:00:00.000Z", senderName: "x", content: "msg" },
    ],
    has_more: true,
  });
  assert.match(out, /Older exist: --before 5\./);
  assert.match(out, /No newer\./);
  assert.match(out, /End of window: 1\/1 shown\./);
});

test("formatHistory: has_more with forward pagination (after)", () => {
  const out = formatHistory("#general", {
    messages: [
      { seq: 20, id: "id20", createdAt: "2026-04-21T05:00:00.000Z", senderName: "x", content: "msg" },
    ],
    has_more: true,
  }, { after: 15 });
  assert.match(out, /No older\./);
  assert.match(out, /Newer exist: --after 20\./);
});

test("formatHistory: around mode shows both directions", () => {
  const out = formatHistory("#general", {
    messages: [
      { seq: 8, id: "id08", createdAt: "2026-04-21T05:00:00.000Z", senderName: "x", content: "before" },
      { seq: 10, id: "id10", createdAt: "2026-04-21T05:01:00.000Z", senderName: "x", content: "target" },
      { seq: 12, id: "id12", createdAt: "2026-04-21T05:02:00.000Z", senderName: "x", content: "after" },
    ],
    has_older: true,
    has_newer: true,
  }, { around: "id10" });
  assert.match(out, /Around: id10\./);
  assert.match(out, /Older exist: --before 8\./);
  assert.match(out, /Newer exist: --after 12\./);
});

test("formatHistory: format-only metadata never references an ack command", () => {
  const out = formatHistory("#general", {
    messages: [
      { seq: 8, id: "id08", createdAt: "2026-04-21T05:00:00.000Z", senderName: "x", content: "message" },
    ],
  });
  assert.doesNotMatch(out, /message ack|attest|model-seen/i);
});

test("formatHistory: task assignee uses resolved handle without opaque id", () => {
  const out = formatHistory("#engineering", {
    messages: [
      {
        seq: 42,
        id: "task1234-aaaa-bbbb-cccc-000000000001",
        createdAt: "2026-04-21T06:00:00.000Z",
        senderType: "human",
        senderName: "bob",
        content: "fix the flaky test",
        taskStatus: "in_progress",
        taskNumber: 61,
        taskAssigneeId: "6e6ef0c5-0da7-4983-a69d-b072a072d355",
        taskAssigneeType: "agent",
        taskAssigneeName: "ApplePI",
      },
    ],
  });
  assert.match(out, /task #61 status=in_progress assignee=@ApplePI/);
  assert.doesNotMatch(out, /6e6ef0c5/);
  assert.doesNotMatch(out, /agent:6e6ef0c5/);
});

test("formatHistory: superseded task root keeps original content and points to current text", () => {
  const out = formatHistory("#runtime", {
    messages: [{
      seq: 928,
      id: "92800000-0000-4000-8000-000000000000",
      createdAt: "2026-08-19T09:00:00.000Z",
      senderType: "user",
      senderName: "tenny",
      content: "original stale premise",
      taskStatus: "in_progress",
      taskNumber: 928,
      taskCurrentProjection: {
        title: "latest narrowed premise",
        description: "current acceptance text",
        revision: 5,
        superseded: true,
        amendedAt: "2026-08-19T09:05:00.000Z",
        amendedByType: "agent",
        amendedByName: "cross",
        source: "tasks_current_projection",
      },
    }],
  });

  assert.match(out, /original stale premise \[task #928 status=in_progress\]/);
  assert.match(out, /current projection rev=5 source=tasks_current_projection actor=@cross/);
  assert.match(out, /Current title: latest narrowed premise/);
  assert.match(out, /Current description: current acceptance text/);
});

test("formatHistory: thread and reply count in header", () => {
  const out = formatHistory("#engineering", {
    messages: [
      { seq: 1, id: "12345678-aaaa-bbbb-cccc-000000000001", createdAt: "2026-04-21T06:00:00.000Z", senderType: "human", senderName: "bob", content: "thread starter", threadId: "t-abc", replyCount: 5 },
    ],
  });
  assert.match(out, /threadId=t-abc/);
  assert.match(out, /replyCount=5/);
  assert.match(out, /replyTarget=#engineering:12345678/);
});

test("formatHistory: top-level channel message without thread state shows reply target", () => {
  const out = formatHistory("#engineering", {
    messages: [
      { seq: 1, id: "12345678-aaaa-bbbb-cccc-000000000001", createdAt: "2026-04-21T06:00:00.000Z", senderType: "human", senderName: "bob", content: "needs a new thread" },
    ],
  });
  assert.match(out, /replyTarget=#engineering:12345678/);
});

test("formatHistory: top-level DM message with thread state shows DM reply target", () => {
  const out = formatHistory("dm:@bob", {
    messages: [
      { seq: 1, id: "deadbeef-aaaa-bbbb-cccc-000000000001", createdAt: "2026-04-21T06:00:00.000Z", senderType: "human", senderName: "bob", content: "dm thread starter", threadId: "t-dm", replyCount: 2 },
    ],
  });
  assert.match(out, /threadId=t-dm/);
  assert.match(out, /replyCount=2/);
  assert.match(out, /replyTarget=dm:@bob:deadbeef/);
});

test("formatHistory: top-level DM message without thread state shows DM reply target", () => {
  const out = formatHistory("dm:@bob", {
    messages: [
      { seq: 1, id: "deadbeef-aaaa-bbbb-cccc-000000000001", createdAt: "2026-04-21T06:00:00.000Z", senderType: "human", senderName: "bob", content: "needs a new dm thread" },
    ],
  });
  assert.match(out, /replyTarget=dm:@bob:deadbeef/);
});

test("formatHistory: thread target suppresses nested reply target", () => {
  const out = formatHistory("#engineering:12345678", {
    messages: [
      { seq: 1, id: "deadbeef-aaaa-bbbb-cccc-000000000001", createdAt: "2026-04-21T06:00:00.000Z", senderType: "human", senderName: "bob", content: "nested?", threadId: "t-nested", replyCount: 1 },
    ],
  });
  assert.doesNotMatch(out, /replyTarget=/);
});

test("formatHistory: historyLimited footer", () => {
  const out = formatHistory("#general", {
    messages: [
      { seq: 1, id: "id01", senderName: "x", content: "old" },
    ],
    historyLimited: true,
    historyLimitMessage: "Free plan: last 50 messages only.",
  });
  assert.match(out, /Free plan: last 50 messages only\./);
});

// ── formatSearchResults (search) ────────────────────────────────────

test("formatSearchResults: empty", () => {
  assert.equal(formatSearchResults("hello", { results: [] }), "No search results.");
});

test("formatSearchResults: filtered browse without query", () => {
  const out = formatSearchResults("", {
    results: [
      {
        id: "res-filtered",
        seq: 56,
        createdAt: "2026-04-21T07:00:00.000Z",
        channelType: "channel",
        channelName: "engineering",
        senderName: "alice",
        senderType: "human",
        content: "sender timeline item",
        snippet: "sender timeline item",
      },
    ],
  });
  assert.match(out, /Filtered message results \(1 result\)/);
  assert.match(out, /sender timeline item/);
  assert.doesNotMatch(out, /<match>/);
});

test("formatSearchResults: single result in channel", () => {
  const out = formatSearchResults("deploy", {
    results: [
      {
        id: "res001",
        seq: 55,
        createdAt: "2026-04-21T07:00:00.000Z",
        channelType: "channel",
        channelName: "engineering",
        senderName: "alice",
        senderType: "human",
        content: "we should deploy the fix today",
        snippet: "we should **deploy** the fix today",
      },
    ],
  });
  assert.equal(
    out,
    [
      'Search results for: "deploy" (1 result)',
      '',
      '<result ref="msg:res001">',
      'Source: channel:engineering',
      'Sender: alice (human)',
      'Time: 2026-04-21 15:00:00 +08:00',
      '',
      '<preview>',
      'we should <match>deploy</match> the fix today',
      '</preview>',
      '</result>',
      '',
      'If a result may be relevant but its preview is not enough, read the surrounding context for that result before answering.',
    ].join("\n"),
  );
});

test("formatSearchResults: thread result with parent", () => {
  const out = formatSearchResults("bug", {
    results: [
      {
        id: "res002",
        seq: 100,
        createdAt: "2026-04-21T08:00:00.000Z",
        channelType: "thread",
        channelName: "thread-deadbeef",
        parentChannelType: "channel",
        parentChannelName: "slock-cli",
        senderName: "kuku",
        senderType: "agent",
        content: "found the bug in parser",
        snippet: "found the **bug** in parser",
        threadId: "deadbeefdeadbeef",
      },
    ],
  });
  assert.match(out, /<result ref="msg:res002">/);
  assert.match(out, /Source: thread:slock-cli:deadbeef/);
  assert.match(out, /Sender: kuku \(agent\)/);
  assert.match(out, /found the <match>bug<\/match> in parser/);
  assert.doesNotMatch(out, /next:/);
  assert.doesNotMatch(out, /raft message read/);
});

test("formatSearchResults: DM result", () => {
  const out = formatSearchResults("hello", {
    results: [
      {
        id: "res003",
        seq: 7,
        channelType: "dm",
        channelName: "bob",
        senderName: "bob",
        senderType: "human",
        content: "hello there",
        snippet: "**hello** there",
      },
    ],
  });
  assert.match(out, /Source: dm:bob/);
  assert.match(out, /Sender: bob \(human\)/);
  assert.match(out, /<match>hello<\/match> there/);
  assert.doesNotMatch(out, /dm:@bob/);
  assert.doesNotMatch(out, /next:/);
});

test("formatSearchResults: amended task hit carries a neutralized current projection", () => {
  const out = formatSearchResults("old premise", {
    results: [{
      id: "res-task-928",
      seq: 928,
      channelType: "channel",
      channelName: "runtime",
      senderName: "tenny",
      senderType: "human",
      content: "old premise from the immutable host message",
      taskStatus: "in_progress",
      taskNumber: 928,
      taskCurrentProjection: {
        title: "new premise owned by @cross",
        description: "current details in #proj-runtime",
        revision: 4,
        superseded: true,
        amendedAt: "2026-08-19T09:05:00.000Z",
        amendedByType: "agent",
        amendedByName: "cross",
        source: "tasks_current_projection",
      },
    }],
  });

  assert.match(out, /\[task #928 superseded: current projection rev=4 source=tasks_current_projection actor=user:cross/);
  assert.match(out, /Current title: new premise owned by user:cross/);
  assert.match(out, /Current description: current details in channel:proj-runtime/);
  assert.match(out, /<match>old premise<\/match> from the immutable host message/);
  assert.deepEqual(extractBareMentionHandles(out), []);
});

test("formatSearchResults: marks omitted boundaries around clipped preview", () => {
  const out = formatSearchResults("rollback", {
    results: [
      {
        id: "res004",
        seq: 1,
        channelType: "channel",
        channelName: "release",
        senderName: "lead",
        senderType: "human",
        content: `${"before ".repeat(30)}the rollback plan is owned by the release lead ${"after ".repeat(30)}`,
      },
    ],
  });

  assert.match(out, /<preview>\n<omit \/>/);
  assert.match(out, /<match>rollback<\/match> plan is owned/);
  assert.match(out, /<omit \/>\n<\/preview>/);
});

test("formatSearchResults: complete short preview has no omit markers", () => {
  const out = formatSearchResults("Monday", {
    results: [
      {
        id: "res005",
        seq: 1,
        channelType: "channel",
        channelName: "release",
        senderName: "lead",
        senderType: "human",
        content: "Rollback plan confirmed. Ship Monday.",
      },
    ],
  });

  assert.match(out, /Rollback plan confirmed\. Ship <match>Monday<\/match>\./);
  assert.doesNotMatch(out, /<omit \/>/);
});

test("formatSearchResults: preserves markdown in preview body", () => {
  const out = formatSearchResults("revert", {
    results: [
      {
        id: "res006",
        seq: 1,
        channelType: "channel",
        channelName: "release",
        senderName: "lead",
        senderType: "human",
        content: [
          "We agreed on **rollback plan**:",
          "",
          "- use one revert commit",
          "- wait for staging",
        ].join("\n"),
      },
    ],
  });

  assert.match(out, /\*\*rollback plan\*\*/);
  assert.match(out, /- use one <match>revert<\/match> commit/);
  assert.match(out, /- wait for staging/);
});

test("formatSearchResults: escapes source literals that collide with MDX components", () => {
  const out = formatSearchResults("deploy", {
    results: [
      {
        id: "res007",
        seq: 1,
        channelType: "channel",
        channelName: "release",
        senderName: "lead",
        senderType: "human",
        content: "source said <match>literal</match> and <omit /> before deploy",
      },
    ],
  });

  assert.match(out, /&lt;match&gt;literal&lt;\/match&gt;/);
  assert.match(out, /&lt;omit \/&gt; before <match>deploy<\/match>/);
});

test("formatSearchResults: readout does not expose side-effecting mention handles", () => {
  const out = formatSearchResults("cache", {
    results: [
      {
        id: "res008",
        seq: 1,
        channelType: "dm",
        channelName: "alice",
        senderName: "bob",
        senderType: "human",
        content: "@alice mentioned #proj-search and task #12 in a cache note",
      },
    ],
  });

  assert.deepEqual(extractBareMentionHandles(out), []);
  assert.match(out, /user:alice mentioned channel:proj-search and task:12/);
  assert.match(out, /Source: dm:alice/);
  assert.doesNotMatch(out, /@\w+/);
  assert.doesNotMatch(out, /\btarget:/);
  assert.doesNotMatch(out, /\bnext:/);
});

test("formatSearchResults: neutralizes ref-shaped text at line starts inside previews", () => {
  const out = formatSearchResults("cache", {
    results: [
      {
        id: "res009",
        seq: 1,
        channelType: "channel",
        channelName: "search",
        senderName: "reviewer",
        senderType: "agent",
        content: [
          "cache note:",
          "@alice owns the follow-up",
          "#proj-search has the discussion",
          "task #12 is related",
        ].join("\n"),
      },
    ],
  });

  assert.deepEqual(extractBareMentionHandles(out), []);
  assert.match(out, /<match>cache<\/match> note:\nuser:alice owns the follow-up/);
  assert.match(out, /channel:proj-search has the discussion/);
  assert.match(out, /task:12 is related/);
});

test("formatSearchResults: neutralizes mentions after escaped component literals", () => {
  const out = formatSearchResults("cache", {
    results: [
      {
        id: "res010",
        seq: 1,
        channelType: "channel",
        channelName: "search",
        senderName: "reviewer",
        senderType: "agent",
        content: "literal component <match>@alice</match> appears before cache",
      },
    ],
  });

  assert.deepEqual(extractBareMentionHandles(out), []);
  assert.match(out, /&lt;match&gt;user:alice&lt;\/match&gt; appears before <match>cache<\/match>/);
});

test("formatSearchResults: expands matches that would split ref-shaped literals", () => {
  const taskOut = formatSearchResults("task", {
    results: [
      {
        id: "res011",
        seq: 1,
        channelType: "channel",
        channelName: "search",
        senderName: "reviewer",
        senderType: "agent",
        content: "Please check task #102 before release.",
      },
    ],
  });

  assert.match(taskOut, /Please check <match>task:102<\/match> before release\./);
  assert.doesNotMatch(taskOut, /<match>task<\/match> #102/);
  assert.doesNotMatch(taskOut.replace(/<\/?match>/g, ""), /\btask #102\b/);

  const mentionOut = formatSearchResults("alice", {
    results: [
      {
        id: "res012",
        seq: 1,
        channelType: "channel",
        channelName: "search",
        senderName: "reviewer",
        senderType: "agent",
        content: "Ask @alice for the release note.",
      },
    ],
  });

  assert.deepEqual(extractBareMentionHandles(mentionOut), []);
  assert.match(mentionOut, /Ask <match>user:alice<\/match> for the release note\./);
  assert.doesNotMatch(mentionOut.replace(/<\/?match>/g, ""), /@alice/);
});
