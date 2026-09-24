import type {
  AgentApiActionPrepareResponse,
  AgentApiIntegrationAppListResponse,
  AgentApiIntegrationAppLogoResponse,
  AgentApiIntegrationAppManageResponse,
  AgentApiIntegrationAppPrepareResponse,
  AgentApiIntegrationAppRotateSecretResponse,
  AgentApiIntegrationAppStatusResponse,
  AgentApiIntegrationAppTransferOwnerResponse,
  AgentApiIntegrationAppUpdateResponse,
  AgentApiOwnedIntegrationApp,
} from "@botiverse/raft-shared";

export function projectAppPrepareReceipt(
  data: AgentApiIntegrationAppPrepareResponse,
): AgentApiIntegrationAppPrepareResponse {
  const action = data.action.type === "integration:register_app"
    ? {
      type: data.action.type,
      name: data.action.name,
      description: data.action.description,
      category: data.action.category,
      homepageUrl: data.action.homepageUrl,
      returnUrl: data.action.returnUrl,
      agentManifestUrl: data.action.agentManifestUrl,
      clientKey: data.action.clientKey,
      scopes: [...data.action.scopes],
      unsafeDemoUrlOverride: data.action.unsafeDemoUrlOverride,
      draftHint: data.action.draftHint,
    }
    : {
      type: data.action.type,
      name: data.action.name,
      description: data.action.description,
      category: data.action.category,
      homepageUrl: data.action.homepageUrl,
      returnUrl: data.action.returnUrl,
      agentManifestUrl: data.action.agentManifestUrl,
      clientKey: data.action.clientKey,
      scopes: data.action.scopes === undefined ? undefined : [...data.action.scopes],
      unsafeDemoUrlOverride: data.action.unsafeDemoUrlOverride,
      draftHint: data.action.draftHint,
    };
  return {
    status: data.status,
    mode: data.mode,
    target: data.target,
    actionCardMessageId: data.actionCardMessageId,
    action,
  };
}

export function projectOwnedIntegrationApp(
  app: AgentApiOwnedIntegrationApp,
): AgentApiOwnedIntegrationApp {
  return {
    state: app.state,
    card: app.card,
    name: app.name,
    clientKey: app.clientKey,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    description: app.description,
    homepageUrl: app.homepageUrl,
    callbackUrl: app.callbackUrl,
    agentManifestUrl: app.agentManifestUrl,
    scopes: [...app.scopes],
    category: app.category,
    dataAccessSummary: app.dataAccessSummary,
    logoUrl: app.logoUrl,
    appType: app.appType,
    publishStatus: app.publishStatus,
    enabled: app.enabled,
    authority: app.authority,
    recoveryCommand: app.recoveryCommand,
  };
}

export function projectAppListReceipt(
  data: AgentApiIntegrationAppListResponse,
): AgentApiIntegrationAppListResponse {
  return { apps: data.apps.map(projectOwnedIntegrationApp) };
}

export function projectAppStatusReceipt(
  data: AgentApiIntegrationAppStatusResponse,
): AgentApiIntegrationAppStatusResponse {
  return { app: projectOwnedIntegrationApp(data.app) };
}

export function projectAppUpdateReceipt(
  data: AgentApiIntegrationAppUpdateResponse,
): AgentApiIntegrationAppUpdateResponse {
  return {
    clientId: data.clientId,
    clientKey: data.clientKey,
    clientName: data.clientName,
    updatedFields: [...data.updatedFields],
  };
}

export function projectAppTransferOwnerReceipt(
  data: AgentApiIntegrationAppTransferOwnerResponse,
): AgentApiIntegrationAppTransferOwnerResponse {
  return {
    clientId: data.clientId,
    clientKey: data.clientKey,
    clientName: data.clientName,
    ownerAgentId: data.ownerAgentId,
    ownerAgentName: data.ownerAgentName,
    ownershipOutcome: data.ownershipOutcome,
    auditEventId: data.auditEventId,
  };
}

export function projectAppManageReceipt(
  data: AgentApiIntegrationAppManageResponse,
): AgentApiIntegrationAppManageResponse {
  return {
    action: data.action,
    clientId: data.clientId,
    clientKey: data.clientKey,
    clientName: data.clientName,
    publishStatus: data.publishStatus,
    logoUrl: data.logoUrl,
    shareUrl: data.shareUrl,
    link: data.link === undefined || data.link === null
      ? data.link
      : {
        id: data.link.id,
        expiresAt: data.link.expiresAt,
        revokedAt: data.link.revokedAt,
        lastUsedAt: data.link.lastUsedAt,
        createdAt: data.link.createdAt,
        updatedAt: data.link.updatedAt,
      },
  };
}

export function projectAppLogoReceipt(
  data: AgentApiIntegrationAppLogoResponse,
): AgentApiIntegrationAppLogoResponse {
  return {
    clientId: data.clientId,
    clientKey: data.clientKey,
    clientName: data.clientName,
    logoUrl: data.logoUrl,
  };
}

export function projectActionPrepareReceipt(
  data: AgentApiActionPrepareResponse,
): AgentApiActionPrepareResponse {
  return {
    messageId: data.messageId,
    metadata: { kind: data.metadata.kind },
  };
}

interface PrivateSecretSinkReceipt {
  path: string;
  mode: "0600";
  created: true;
  containsSecret: true;
  selection: "agent-selected";
  binding: "caller-managed-after-return";
}

export function projectAppRotateSecretToFileReceipt(
  data: AgentApiIntegrationAppRotateSecretResponse,
  secretSink: PrivateSecretSinkReceipt,
) {
  return {
    clientId: data.clientId,
    clientKey: data.clientKey,
    clientName: data.clientName,
    secretSink,
    secretDisclosure: "none" as const,
    next: "keep this path out of Web/static/shared surfaces, pass the file directly to the authorized runtime secret-store command, then securely remove it",
  };
}
