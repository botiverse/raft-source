// Shared example fixtures for axSurface definitions (@xxchan: reuse samples
// per data type instead of rewriting them at every surface).
//
// PURE DATA, placeholder identifiers only — never real ids, names or content.
// Each sample is a canonical instance of a commonly-reused shape; definitions
// spread-and-override for variants (`{ ...sampleTask, status: "todo" }`).

export const T = "2026-08-31T08:00:00.000Z";
export const UUID_A = "00000000-1111-2222-3333-444444444444";
export const UUID_B = "55555555-6666-7777-8888-999999999999";
export const UUID_C = "aaaabbbb-0000-0000-0000-000000000000";

export const sampleMessage = {
  channel_type: "channel",
  channel_name: "general",
  message_id: UUID_A,
  timestamp: T,
  sender_type: "human",
  sender_name: "richard",
  content: "hello everyone",
  seq: 1200,
};

// Target-shape variants (@xxchan 8/31): message examples must cover all four
// target forms — channel, channel thread, dm, dm thread. The thread short id
// comes from channel_name ("thread-" + first 8 of the parent message id).
export const sampleMessageChannelThread = {
  ...sampleMessage,
  channel_type: "thread",
  channel_name: "thread-00000000",
  parent_channel_name: "general",
  parent_channel_type: "channel",
  message_id: UUID_B,
  seq: 1201,
  content: "thread reply",
};

export const sampleMessageDm = {
  ...sampleMessage,
  channel_type: "dm",
  channel_name: "richard",
  message_id: UUID_B,
  seq: 1201,
  content: "hey, can you help?",
};

export const sampleMessageDmThread = {
  ...sampleMessage,
  channel_type: "thread",
  channel_name: "thread-55555555",
  parent_channel_name: "richard",
  parent_channel_type: "dm",
  message_id: UUID_C,
  seq: 1202,
  content: "DM thread reply",
};

export const sampleTask = {
  number: 42,
  title: "do the thing",
  status: "in_progress",
  claimedById: "a-1",
  claimedByName: "Alice",
  createdByName: "richard",
  messageId: UUID_A,
};

export const sampleReminder = {
  reminderId: "76d9397d-0000-0000-0000-000000000000",
  ownerAgentId: "a-1",
  title: "check deploy status",
  fireAt: "2026-08-31T09:00:00.000Z",
  createdAt: T,
  status: "scheduled" as const,
  msgRef: "#general:00000000",
  msgPermalink: "https://example.raft.build/m/00000000",
  recurrence: { kind: "interval" as const, description: "every 20 minutes" },
};

export const sampleChannel = {
  id: "c-1",
  name: "general",
  joined: true,
  type: "channel",
  description: "team-wide chat",
};

export const sampleAgentInfo = { name: "Alice", status: "online", role: null, description: "example agent" };
export const sampleHumanInfo = { name: "richard", role: "owner" as const, description: null };

export const sampleProfilePaths = {
  profileSlug: "alice",
  profileDir: "/p",
  credentialPath: "/p/alice/credential.json",
};
export const sampleLoginOptions = { server: "https://raft.example", agent: "alice" };
