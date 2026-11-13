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
  post(url: string, body?: unknown, config?: { withCredentials?: boolean }): Promise<{ data: unknown }>;
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
    const response = await client.get(`${PROVISIONING_PATH}?deliveryHealth=1&pairDeliveryHealth=1&workspaceAdminHint=1&confirmationHint=1&privateAuthorizerHint=1&attachmentSourceHealth=1&inboundRecovery=1&cardEditNotices=1`);
    return accept(response.data);
  };

  const beginOAuth = async (): Promise<SlackBridgeOAuthResult> => {
    if (!current) await load();
    const authority: SlackBridgeOAuthAuthority | null = current?.oauthAuthority ?? null;
    if (current?.snapshot.stage !== "oauth" || !authority) {
      if (!current) throw new Error("Slack Bridge provisioning snapshot is unavailable");
      return { kind: "view", view: ready(current) };
    }

    // withCredentials: the response sets the HttpOnly cookie that binds this install to this
    // browser; Slack's redirect back to the API callback must carry it.
    const response = await client.post("/slack-bridge/oauth/start", authority, { withCredentials: true });
    const result = slackBridgeOAuthStartResponseSchema.parse(response.data);
    return { kind: "redirect", url: result.authorizationUrl };
  };

  const beginReauthorization = async (): Promise<SlackBridgeOAuthResult> => {
    await load();
    const authority: SlackBridgeOAuthAuthority | null = current?.oauthAuthority ?? null;
    const stage = current?.snapshot.stage;
    if (!authority || stage === "connect" || stage === "oauth") {
      if (!current) throw new Error("Slack Bridge provisioning snapshot is unavailable");
      return { kind: "view", view: ready(current) };
    }

    // withCredentials: the response sets the HttpOnly cookie that binds this install to this
    // browser; Slack's redirect back to the API callback must carry it.
    const response = await client.post("/slack-bridge/oauth/start", authority, { withCredentials: true });
    const result = slackBridgeOAuthStartResponseSchema.parse(response.data);
    return { kind: "redirect", url: result.authorizationUrl };
  };

  return {
    load,
    replayInbound: async (event) => {
      const response = await client.post(`${PROVISIONING_PATH}/replay-inbound`, event);
      return accept(response.data);
    },
    retryDelivery: async (delivery) => {
      const response = await client.post(`${PROVISIONING_PATH}/retry-delivery`, {
        bindingId: delivery.bindingId,
        bindingEpoch: delivery.bindingEpoch,
        deliveryId: delivery.deliveryId,
        expectedProviderAttempts: delivery.providerAttempts,
        duplicateRiskAcknowledged: true,
      });
      return accept(response.data);
    },
    connect: async () => {
      const response = await client.post(`${PROVISIONING_PATH}/connect`);
      return accept(response.data);
    },
    beginOAuth,
    beginReauthorization,
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
      accept(response.data);
      // Enable responses preserve the older browser contract. Re-read with the
      // explicit delivery-health opt-in before showing a successful recovery.
      return load();
    },
  };
}

export const slackBridgeProvisioningProvider = createSlackBridgeProvisioningProvider();
