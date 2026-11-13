import type { SlackTestIdentityObserver } from "./slackInboundIdentityObservation";
import type { SlackBridgeRouteDependencies } from "../routes/slackBridge";
import type { SlackVerifiedIngressPayloadCrypto } from "./slackVerifiedIngressContracts";
import type {
  ExternalIngressPayloadSealer,
  ExternalIngressRuntimeResolver,
  ExternalIngressSecretResolver,
} from "./externalAppIngressService";
import {
  createSlackOAuthExchangeAdapter,
  createSlackOAuthHttpTransport,
  createSlackOAuthManagedHandleCoordinator,
  type SlackBotCredentialSealer,
  type SlackIngressAuthorityAdapter,
  type SlackOAuthAppSecretLeaseProvider,
} from "./slackProviderAdapter";

export interface SlackBridgeManagedRuntimeDependencies {
  environment: "test" | "production";
  oauthRedirectUri: string;
  eventsRequestUrl: string;
  appOrigin: string;
  isLaunchEnabled: SlackBridgeRouteDependencies["isLaunchEnabled"];
  resolveOAuthCompletionRedirectPath:
    SlackBridgeRouteDependencies["resolveOAuthCompletionRedirectPath"];
  appSecrets: SlackOAuthAppSecretLeaseProvider;
  credentialSealer: SlackBotCredentialSealer;
  secretResolver: ExternalIngressSecretResolver;
  payloadSealer: ExternalIngressPayloadSealer;
  verifiedIngressCrypto?: SlackVerifiedIngressPayloadCrypto;
  provisioning?: SlackBridgeRouteDependencies["provisioning"];
  runtimeResolver?: ExternalIngressRuntimeResolver;
  testIdentityObserver?: SlackTestIdentityObserver;
  admitSlackIngress?: SlackIngressAuthorityAdapter;
  requestLifecycleReconcile?(bindingId?: string): Promise<unknown> | void;
  readLifecycleMemberProfile?: SlackBridgeRouteDependencies["readLifecycleMemberProfile"];
  onLifecycleError?(error: unknown): void;
  fetch?: typeof fetch;
  oauthEndpoint?: string;
  oauthTimeoutMs?: number;
  oauthMaxResponseBytes?: number;
  oauthHandleTtlMs?: number;
  randomHandleId?: () => string;
  now?(): Date;
}

export interface SlackBridgeManagedRuntime extends SlackBridgeRouteDependencies {
  stop(): void;
}

/**
 * Composes the deployable Slack OAuth and ingress route dependencies without
 * taking custody of raw secrets at the HTTP route boundary. Deployments still
 * have to provide the durable secret adapters explicitly.
 */
export function createSlackBridgeManagedRuntime(
  dependencies: SlackBridgeManagedRuntimeDependencies,
): SlackBridgeManagedRuntime {
  const coordinator = createSlackOAuthManagedHandleCoordinator({
    appSecrets: dependencies.appSecrets,
    handleTtlMs: dependencies.oauthHandleTtlMs,
    randomHandleId: dependencies.randomHandleId,
  });
  const exchangeOAuth = createSlackOAuthExchangeAdapter({
    transport: createSlackOAuthHttpTransport({
      handles: coordinator.handles,
      credentialSealer: dependencies.credentialSealer,
      fetch: dependencies.fetch,
      endpoint: dependencies.oauthEndpoint,
      timeoutMs: dependencies.oauthTimeoutMs,
      maxResponseBytes: dependencies.oauthMaxResponseBytes,
    }),
  });

  return {
    environment: dependencies.environment,
    oauthRedirectUri: dependencies.oauthRedirectUri,
    eventsRequestUrl: dependencies.eventsRequestUrl,
    appOrigin: dependencies.appOrigin,
    isLaunchEnabled: dependencies.isLaunchEnabled,
    resolveOAuthCompletionRedirectPath: dependencies.resolveOAuthCompletionRedirectPath,
    leaseOAuthAppCredential: coordinator.leaseAppCredential,
    captureAuthorizationCode: coordinator.captureAuthorizationCode,
    exchangeOAuth,
    secretResolver: dependencies.secretResolver,
    payloadSealer: dependencies.payloadSealer,
    verifiedIngressCrypto: dependencies.verifiedIngressCrypto,
    provisioning: dependencies.provisioning,
    runtimeResolver: dependencies.runtimeResolver,
    testIdentityObserver: dependencies.testIdentityObserver,
    admitSlackIngress: dependencies.admitSlackIngress,
    requestLifecycleReconcile: dependencies.requestLifecycleReconcile,
    readLifecycleMemberProfile: dependencies.readLifecycleMemberProfile,
    onLifecycleError: dependencies.onLifecycleError,
    now: dependencies.now,
    stop: coordinator.stop,
  };
}
