// Agent Lounge v0 (#proj-chat:#15), the reverse check: another agent may read a
// lounge but never take part. Every agent API route that is not a plain read
// must be classified here by how a lounge stays closed to other agents, so a
// new write route fails this test until someone decides which it is.
//
//   membership     needs the agent to be a channel member (canAgentPostToChannel /
//                  isChannelAgent, or resolveWritableAgentTarget, which calls it);
//                  trigger channel_agents_agent_lounge_guard keeps every agent but
//                  the lounge's own from being one.
//   capability     a channel management capability; channelActorHasCapability
//                  answers false for any agent on a lounge (context.agentLounge).
//   loungeCheck    does not need membership; calls isLoungeOutsiderAgent itself.
//   notChannel     writes nothing into a conversation (the agent's own settings,
//                  reminders it already owns, artifacts' own threads, apps, ...).
import assert from "node:assert/strict";
import { AGENT_API_ROUTE_MANIFEST } from "@botiverse/raft-shared/src/generated/agentApiRoutes";

type LoungeWriteClass = "membership" | "capability" | "loungeCheck" | "notChannel";

const AGENT_LOUNGE_WRITE_CLASSIFICATION: Readonly<Record<string, LoungeWriteClass>> = {
  messageSend: "membership",
  messageSendV2: "membership",
  messageReactionAdd: "membership",
  messageReactionRemove: "membership",
  // RFC 082: only the card's sender, still able to post there (canAgentPostToChannel).
  messageCardUpdate: "membership",
  channelLeave: "membership",
  channelMute: "membership",
  channelUnmute: "membership",
  taskCreate: "membership",
  taskClaim: "membership",
  taskUnclaim: "membership",
  taskAssign: "membership",
  taskUpdateStatus: "membership",
  taskResourceReceipt: "membership",
  taskDelete: "membership",
  taskConvert: "membership",
  taskAmend: "membership",
  taskReply: "membership",
  attachmentUpload: "membership",
  attachmentUploadSessionCreate: "membership",
  actionPrepare: "membership",

  channelArchive: "capability",
  channelUnarchive: "capability",
  channelUpdate: "capability",
  channelMemberRemove: "capability",

  channelJoin: "loungeCheck",
  channelMemberAdd: "loungeCheck",
  threadFollow: "loungeCheck",
  taskFollow: "loungeCheck",
  mentionActionsExecute: "loungeCheck",
  reminderCreate: "loungeCheck",
  artifactPublish: "loungeCheck",
  artifactImport: "loungeCheck",
  artifactSaveAttachment: "loungeCheck",
  // A personal assistant's publish (#proj-assistant:#31) runs Artifacts' own publish, which places by the same lounge check.
  assistantOwnerArtifactPublish: "loungeCheck",

  // The upload session was opened under the membership check; finishing or
  // dropping it posts nothing (a send does).
  // Only the question card's own agent, which posted it under the membership check; posts nothing.
  actionWithdraw: "notChannel",
  attachmentUploadSessionComplete: "notChannel",
  attachmentUploadSessionCancel: "notChannel",
  // The agent's own event stream (receiving acknowledges).
  events: "notChannel",
  // RFC 081: the agent's own read state (its read position, its own app events); posts nothing.
  inboxRead: "notChannel",
  inboxDismiss: "notChannel",
  raftbenchSubmit: "notChannel",
  feedbackLocatorIngest: "notChannel",
  managedMcpCall: "notChannel",
  channelCreate: "notChannel",
  resolveChannel: "notChannel",
  threadUnfollow: "notChannel",
  taskUnfollow: "notChannel",
  taskIdleNudge: "notChannel",
  migrationRetry: "notChannel",
  assistantContactRuleAdd: "notChannel",
  assistantContactRuleRemove: "notChannel",
  assistantContactSettings: "notChannel",
  assistantOwnerSettingsUpdate: "notChannel",
  assistantContactRulesImport: "notChannel",
  assistantToldRecord: "notChannel",
  assistantNotify: "notChannel",
  assistantCheckStateImport: "notChannel",
  assistantSendAsOwner: "notChannel",
  assistantForwardAsOwner: "notChannel",
  serverUpdate: "notChannel",
  serverLabsAccess: "notChannel",
  serverLabEnrollment: "notChannel",
  reminderCancel: "notChannel",
  reminderSnooze: "notChannel",
  reminderUpdate: "notChannel",
  appSourceAck: "notChannel",
  appConfigPatch: "notChannel",
  profileUpdate: "notChannel",
  profileAvatarUpdate: "notChannel",
  integrationToken: "notChannel",
  integrationLogin: "notChannel",
  integrationAppPrepare: "notChannel",
  integrationAppRotateSecret: "notChannel",
  integrationAppTransferOwner: "notChannel",
  integrationAppUpdate: "notChannel",
  integrationAppManage: "notChannel",
  integrationAppLogoUpdate: "notChannel",
  pushWebhookRegister: "notChannel",
  pushWebhookDelete: "notChannel",
  artifactUpload: "notChannel",
  artifactCommentImageUpload: "notChannel",
  artifactComment: "notChannel",
  artifactReview: "notChannel",
  artifactCommentResolve: "notChannel",
  artifactCommentReopen: "notChannel",
  artifactSubscribe: "notChannel",
  artifactUnsubscribe: "notChannel",
  artifactMove: "notChannel",
  artifactDelete: "notChannel",
  // #wg-ax:#15: POST only to carry a query; the agent reads its own View Context and writes nothing into a conversation.
  contextSearch: "notChannel",
  contextRead: "notChannel",
};

test("every agent API route that is not a plain read is classified for Agent Lounge", () => {
  const writes = AGENT_API_ROUTE_MANIFEST
    .filter((route) => !(route.method === "GET" && route.sideEffect === "read"))
    .map((route) => route.key)
    .sort();
  assert.deepEqual(Object.keys(AGENT_LOUNGE_WRITE_CLASSIFICATION).sort(), writes);
});
