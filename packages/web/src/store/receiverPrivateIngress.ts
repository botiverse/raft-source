import { getCurrentPrincipalId } from "./principalRuntime";
import { useProfileStore } from "./profileStore";
import { useServerStore } from "./serverStore";

export interface ReceiverPrivateIngressContext {
  serverId: string | null;
  principalId: string | null;
  serverEpoch: number;
  generation: number;
  receiver?: { kind: "agent"; id: string };
}

let receiverPrivateIngressGeneration = 0;
let readCurrentPrincipalId = getCurrentPrincipalId;

export function captureReadAllReceiver(): { kind: "agent"; id: string } | undefined {
  const { profileType, profileId } = useProfileStore.getState();
  return profileType === "agent" && profileId
    ? { kind: "agent", id: profileId }
    : undefined;
}

export function isReadAllReceiverCurrent(
  receiver: ReceiverPrivateIngressContext["receiver"],
): boolean {
  const current = captureReadAllReceiver();
  return receiver?.kind === current?.kind && receiver?.id === current?.id;
}

export function registerReceiverPrivatePrincipalReader(reader: () => string | null): void {
  readCurrentPrincipalId = reader;
}

export function captureReceiverPrivateIngressContext(
  currentUserId: string | null,
): ReceiverPrivateIngressContext {
  return {
    serverId: useServerStore.getState().current?.id ?? null,
    principalId: currentUserId,
    serverEpoch: useServerStore.getState().serverEpoch,
    generation: receiverPrivateIngressGeneration,
    receiver: captureReadAllReceiver(),
  };
}

/**
 * Activity `/channels/inbox` is currently a human-self read model. A profile
 * shown in the right-side overlay is presentation state, not the authority for
 * those rows, so it must never retarget their writes to an agent cursor.
 */
export function captureHumanActivityIngressContext(
  currentUserId: string | null,
): ReceiverPrivateIngressContext {
  return {
    serverId: useServerStore.getState().current?.id ?? null,
    principalId: currentUserId,
    serverEpoch: useServerStore.getState().serverEpoch,
    generation: receiverPrivateIngressGeneration,
    receiver: undefined,
  };
}

export function isReceiverPrivateIngressContextCurrent(
  context: ReceiverPrivateIngressContext,
): boolean {
  return context.generation === receiverPrivateIngressGeneration
    && context.principalId === readCurrentPrincipalId()
    && context.serverId === (useServerStore.getState().current?.id ?? null)
    && context.serverEpoch === useServerStore.getState().serverEpoch;
}

export function invalidateReceiverPrivateIngressContexts(): void {
  receiverPrivateIngressGeneration += 1;
}
