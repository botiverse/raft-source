import {
  slackBridgeOAuthStartResponseSchema,
  slackBridgeProvisioningResponseSchema,
} from "@botiverse/raft-shared";
import type {
  SlackBridgeChannelPair,
  SlackBridgeOAuthAuthority,
  SlackBridgeProvisioningResponse,
} from "@botiverse/raft-shared";
import api from "../../api/client";
import type {
  SlackBridgeOAuthResult,
  SlackBridgeProvisioningProvider,
  SlackBridgeProvisioningView,
} from "./slackBridgeProvisioning";

export interface SlackBridgeProvisioningHttpClient {
  get(url: string): Promise<{ data: unknown }>;
  post(url: string, body?: unknown): Promise<{ data: unknown }>;
  put(url: string, body?: unknown): Promise<{ data: unknown }>;
  delete?(url: string, options?: { data?: unknown }): Promise<{ data: unknown }>;
}

const PROVISIONING_PATH = "/slack-bridge/provisioning";

function ready(response: SlackBridgeProvisioningResponse): SlackBridgeProvisioningView {
  return { kind: "ready", snapshot: response.snapshot };
}

/**
 * Production adapter for the versioned Slack Bridge control-plane seam.
 * Every response is runtime-validated before it can advance the wizard. A
 * missing #8 backend therefore rejects/fails closed; it cannot manufacture a
 * Connect, preflight, Enable, or healthy success state in the browser.
 */
export function createSlackBridgeProvisioningProvider(
  client: SlackBridgeProvisioningHttpClient = api,
): SlackBridgeProvisioningProvider {
  let current: SlackBridgeProvisioningResponse | null = null;

  const accept = (value: unknown): SlackBridgeProvisioningView => {
    current = slackBridgeProvisioningResponseSchema.parse(value);
    return ready(current);
  };

  const load = async (): Promise<SlackBridgeProvisioningView> => {
    const response = await client.get(PROVISIONING_PATH);
    return accept(response.data);
  };

  const beginOAuth = async (): Promise<SlackBridgeOAuthResult> => {
    if (!current) await load();
    const authority: SlackBridgeOAuthAuthority | null = current?.oauthAuthority ?? null;
    if (current?.snapshot.stage !== "oauth" || !authority) {
      if (!current) throw new Error("Slack Bridge provisioning snapshot is unavailable");
      return { kind: "view", view: ready(current) };
    }

    const response = await client.post("/slack-bridge/oauth/start", authority);
    const result = slackBridgeOAuthStartResponseSchema.parse(response.data);
    return { kind: "redirect", url: result.authorizationUrl };
  };

  return {
    load,
    connect: async () => {
      const response = await client.post(`${PROVISIONING_PATH}/connect`);
      return accept(response.data);
    },
    beginOAuth,
    saveChannelPairs: async (pairs: readonly SlackBridgeChannelPair[]) => {
      const response = await client.put(`${PROVISIONING_PATH}/channel-pairs`, {
        pairs: pairs.map(({ raftChannelId, slackChannelId }) => ({ raftChannelId, slackChannelId })),
      });
      return accept(response.data);
    },
    removeChannelPair: async ({ raftChannelId, slackChannelId, expectedBindingEpoch }) => {
      if (!client.delete) throw new Error("Slack Bridge channel removal is unavailable");
      const response = await client.delete(`${PROVISIONING_PATH}/channel-pairs`, {
        data: { pairs: [{ raftChannelId, slackChannelId, expectedBindingEpoch }] },
      });
      return accept(response.data);
    },
    disconnect: async (expectedConnectionEpoch: number) => {
      const response = await client.post(`${PROVISIONING_PATH}/disconnect`, { expectedConnectionEpoch });
      return accept(response.data);
    },
    runPreflight: async () => {
      const response = await client.post(`${PROVISIONING_PATH}/preflight`);
      return accept(response.data);
    },
    enable: async () => {
      const response = await client.post(`${PROVISIONING_PATH}/enable`);
      return accept(response.data);
    },
  };
}

export const slackBridgeProvisioningProvider = createSlackBridgeProvisioningProvider();
