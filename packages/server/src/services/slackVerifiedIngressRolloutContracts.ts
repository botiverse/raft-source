/** The minimum writer protocol is sticky once durable Slack receipt custody starts. */
export const SLACK_VERIFIED_INGRESS_PROTOCOL = 3;
/** Protocol 3 readers accept frozen Slack bot IDs as literal text. */
export const SLACK_BOT_MENTION_READER_PROTOCOL = 3;
export const SLACK_VERIFIED_INGRESS_BASE_PROTOCOL = 1;
export const SLACK_BOT_SYNC_PROTOCOL = 2;
export const SLACK_VERIFIED_INGRESS_FENCE_KEY = -1627910629031853952n;
export const SLACK_VERIFIED_INGRESS_PROTOCOL_SETTING = "raft.slack_ingress_protocol";

export type SlackIngressReleaseRecord = string & { readonly __slackIngressReleaseRecord: unique symbol };

/** Operator-input adapter: the human verifies the referenced full-fleet release record. */
export function parseSlackIngressReleaseRecord(value: string): SlackIngressReleaseRecord {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error("A full Raft release-record message UUID is required");
  }
  return value.toLowerCase() as SlackIngressReleaseRecord;
}

export type SlackIngressRolloutMode = "legacy" | "verified_paused" | "verified_active";

export class SlackIngressRolloutUnavailable extends Error {
  constructor(readonly reason: "not_enabled" | "paused" | "unsupported_protocol" | "fence_missing" | "index_not_ready" | "admission_changed") {
    super(`Slack ingress rollout unavailable: ${reason}`);
  }
}
