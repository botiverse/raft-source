import {
  evaluateFeatureFlag,
  MESSAGE_FORWARDING_FEATURE_FLAG_KEY,
} from "../services/featureFlagService.js";

const MESSAGE_FORWARDING_APP_OVERRIDE = "messageForwardingEnabled";

type AppSettingsReader = {
  get(name: string): unknown;
};

type AppSettingsWriter = {
  set(name: string, value: unknown): unknown;
};

export async function isMessageForwardingEnabledForServer(input: {
  app?: AppSettingsReader;
  userId?: string | null;
  serverId?: string | null;
}): Promise<boolean> {
  const { app, userId, serverId } = input;
  const override = app?.get(MESSAGE_FORWARDING_APP_OVERRIDE);
  if (typeof override === "boolean") return override;
  const evaluation = await evaluateFeatureFlag({
    key: MESSAGE_FORWARDING_FEATURE_FLAG_KEY,
    userId,
    serverId,
  });
  return evaluation.enabled;
}

export function setMessageForwardingEnabledForApp(app: AppSettingsWriter, enabled: boolean) {
  app.set(MESSAGE_FORWARDING_APP_OVERRIDE, enabled);
}
