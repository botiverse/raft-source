// An agent's upload refused by a Free limit Pro lifts (the monthly upload
// quota; a file over the Free plan's per-file limit, which the CLI declares to
// an upload session) offers an upgrade card, as its 30-day read limit does
// (#11021, task #9 #proj-commercial); unlike the read's, its next action says
// the file was not uploaded and gives the command to run (agentUpgradeCardHint
// in agentUpgradeCardService). Only a client that can post the card gets it
// (it declares so in the request's `X-Raft-Client-Capabilities`, or the
// agent's Computer runs 1.0.53 or later); any other keeps the refusal's own
// next action (the quota's billing line). An upload names its conversation
// by id, so the card's target is rebuilt here the way the agent writes it (as
// history reads build theirs, internalAgentApi serveAgentHistoryRead). The
// Artifacts app's agent writes over the monthly quota (push, save, comment
// image) get the same offer through platform/fileUploadQuota
// agentQuotaUpgradeHint (no request capabilities there: the Computer's version
// decides).

import type { UpgradeGate } from "@botiverse/raft-shared";
import { agentUpgradeCardHint, type UpgradeCardUploadSubject } from "./agentUpgradeCardService";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import {
  buildFileUploadQuotaExceededResponse,
  type FileUploadQuotaExceededError,
  type FileUploadQuotaExceededResponse,
} from "./fileUploadQuotaService";
import { serializeErrorForLog } from "../tracing/safeErrorLog";

/**
 * How an agent names conversation `channelId` in a command: `#general`,
 * `dm:@alice`, or a thread as `#general:1a2b3c4d`. Null for a task
 * conversation (not a card target; resolveAgentFacingChannelRef refuses it)
 * or one the agent cannot see.
 */
async function agentFacingConversationTarget(serverId: string, agentId: string, channelId: string): Promise<string | null> {
  const channel = await channelService.getChannel(channelId);
  if (!channel) return null;
  if (channel.type !== "thread") return channelService.resolveAgentFacingChannelRef(serverId, agentId, channelId);
  if (!channel.parentMessageId) return null;
  const parent = await messageService.getMessage(channel.parentMessageId);
  const parentTarget = parent
    ? await channelService.resolveAgentFacingChannelRef(serverId, agentId, parent.channelId)
    : null;
  return parentTarget ? `${parentTarget}:${channel.parentMessageId.slice(0, 8)}` : null;
}

/**
 * `agentUpgradeCardHint` for an upload into `channelId` by a client that
 * declared `capabilities` (the request's `X-Raft-Client-Capabilities`); null
 * where it offers no card. It only adds to a refusal, so a failed lookup is no
 * card rather than a failed request (the refusal keeps its own next action).
 */
export async function agentUploadUpgradeHint(input: {
  serverId: string;
  agentId: string;
  channelId: string;
  capabilities: string | undefined;
  gate: Extract<UpgradeGate, "upload_monthly_quota" | "upload_file_size">;
  /** What was refused (default `file`, an attachment's; agentUpgradeCardHint). */
  uploadSubject?: UpgradeCardUploadSubject;
}): Promise<string | null> {
  try {
    const target = await agentFacingConversationTarget(input.serverId, input.agentId, input.channelId);
    if (!target) return null;
    return await agentUpgradeCardHint({
      serverId: input.serverId,
      gate: input.gate,
      target,
      channelId: input.channelId,
      client: { capabilities: input.capabilities, agentId: input.agentId },
      ...(input.uploadSubject ? { uploadSubject: input.uploadSubject } : {}),
    });
  } catch (err) {
    console.error("agent upload upgrade hint failed:", serializeErrorForLog(err));
    return null;
  }
}

/**
 * The monthly-quota refusal an agent gets: the card offer for the upload's
 * conversation as its next action where there is one (and the client can post
 * it), else the billing line (say why the file wasn't uploaded; a server owner
 * can look at Settings > Billing).
 */
export async function agentFileUploadQuotaExceededResponse(
  input: { serverId: string; agentId: string; channelId: string | undefined; capabilities: string | undefined },
  err: FileUploadQuotaExceededError,
): Promise<FileUploadQuotaExceededResponse> {
  const { serverId, agentId, channelId, capabilities } = input;
  const response = await buildFileUploadQuotaExceededResponse(serverId, err, "agent");
  const hint = channelId && err.summary.plan === "free"
    ? await agentUploadUpgradeHint({ serverId, agentId, channelId, capabilities, gate: "upload_monthly_quota" })
    : null;
  return hint ? { ...response, suggestedNextAction: hint } : response;
}
