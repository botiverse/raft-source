import type { Database } from "../db/index";
import { verifyAndAdmitSlackIngress } from "./externalAppIngressService";
import type { SlackIngressAuthorityAdapter } from "./slackProviderAdapter";
import type { SlackVerifiedIngressPayloadCrypto } from "./slackVerifiedIngressContracts";
import { withSlackIngressAdmissionFence } from "./slackVerifiedIngressRollout";

/** Preserve all verified observation/lifecycle callbacks while choosing custody from real DB state. */
export function createSlackVerifiedIngressAdmission(input: {
  getFenceDb: () => Database;
  crypto: SlackVerifiedIngressPayloadCrypto;
  admit?: SlackIngressAuthorityAdapter;
}): SlackIngressAuthorityAdapter {
  const admit = input.admit ?? verifyAndAdmitSlackIngress;
  return request => withSlackIngressAdmissionFence({ fenceDb: input.getFenceDb(), run: mode => admit({
    ...request, verifiedIngressCrypto: mode === "legacy" ? undefined : input.crypto,
  }) });
}
