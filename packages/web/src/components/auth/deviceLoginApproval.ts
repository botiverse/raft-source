// What a device login is and how its approval reads, shared by the device
// login page (pages/DeviceLoginPage.tsx) and Add Computer's "the terminal
// shows a code" field (features/computer/AddComputerCodeReview.tsx). Both
// call the same two routes (POST /auth/device/describe, /auth/device/approve)
// through useDeviceLoginApproval and show the same confirm screen
// (DeviceLoginRequestDetails).

import type { IntlShape } from "react-intl";

/** A server the person may add a machine to (describe's `grant.servers`). */
export type AttachableServer = { id: string; slug: string; name: string };

/** An agent the person may give a key to (describe's `grant.agents`). */
export type KeyableAgent = { id: string; name: string; displayName: string | null; serverId: string; serverName: string };

/** The machine's own account of itself: whoever started the login chose every field. */
type GrantRequester = { machineName: string | null; hostname: string | null; os: string | null };

/** A one-time grant: what the login asks for, and what this person may pick. */
export type DeviceLoginGrant =
  | (GrantRequester & { kind: "computer_attach"; servers: AttachableServer[] })
  // The same server pick as an attach; the computer then adopts one of the
  // person's own old daemons on that server.
  | (GrantRequester & { kind: "computer_migrate"; servers: AttachableServer[] })
  // requestedAgentId is deliberately unused: the requester sets it, so it must
  // not steer which agent the approver picks.
  | (GrantRequester & { kind: "agent_key"; requestedAgentId: string | null; agents: KeyableAgent[] });

export type GrantKind = DeviceLoginGrant["kind"];

/** What `POST /auth/device/describe` answers for a code that can still be approved. */
export type DeviceLoginRequest = {
  /** The typed code in its stored form (device mode). */
  userCode?: string;
  /** A loopback login: found by the approval link's id instead of a code. */
  mode?: "loopback";
  requestId?: string;
  clientName: string | null;
  requestedAt: string;
  requester: { ip: string | null; location: string | null };
  /** Approve needs it: proof this page checked the code (a page that approves from its link has none). */
  approvalTicket: string;
  /** Present when the login asks for a one-time grant instead of a session. */
  grant?: DeviceLoginGrant;
  /**
   * Never from the wire: set by Add Computer for a request that reached it
   * through its pairing (features/computer/useComputerPairing.ts), which is
   * then approved by the pairing (POST /computer-pairings/approve), not by
   * its code. Held in memory only.
   */
  pairingId?: string;
};

/** One row of the picker, the same shape for a server and an agent. */
export type GrantChoice = { id: string; label: string; detail: string; mono: boolean };

export function grantChoices(grant: DeviceLoginGrant): GrantChoice[] {
  if (grant.kind === "computer_attach" || grant.kind === "computer_migrate") {
    // DS › Switching servers: a server is its name and its address in Space Mono.
    return grant.servers.map((server) => ({ id: server.id, label: server.name, detail: `/${server.slug}`, mono: true }));
  }
  return grant.agents.map((agent) => ({
    id: agent.id,
    label: agent.displayName || agent.name,
    detail: agent.displayName && agent.displayName !== agent.name ? `${agent.name} · ${agent.serverName}` : agent.serverName,
    mono: false,
  }));
}

/** A grant the confirm screen knows how to show; any other kind is refused before a pick. */
export function isKnownGrant(grant: DeviceLoginGrant | undefined): boolean {
  return grant === undefined || grant.kind === "computer_attach" || grant.kind === "computer_migrate" || grant.kind === "agent_key";
}

/** What the approved screen says was granted (null: a legacy device session). */
export type GrantOutcome = { kind: GrantKind; requesterName: string | null; pickedName: string };

/** What a refused describe or approve call carries (axios error). */
export type DeviceLoginFailure = { response?: { data?: { code?: string; error?: string; methods?: unknown } } };

/** How describe and approve name the request: the typed code, or the loopback link's id. */
export type RequestLocator = { userCode: string } | { requestId: string };

export function locatorOf(request: DeviceLoginRequest): RequestLocator {
  return request.mode === "loopback" && request.requestId ? { requestId: request.requestId } : { userCode: request.userCode ?? "" };
}

/** A typed code as describe takes it; the server folds dashes, spaces and look-alikes itself. */
export function normalizeUserCode(value: string): string {
  return value.trim().toUpperCase();
}

/** The confirm screen's heading: what the login asks for, by the name it gave. */
export function deviceLoginConfirmTitle(formatMessage: IntlShape["formatMessage"], grant: DeviceLoginGrant | undefined): string {
  if (!grant) return formatMessage({ id: "pages.deviceLogin.confirmTitle" });
  const name = grant.machineName;
  if (grant.kind === "computer_migrate") {
    return name ? formatMessage({ id: "pages.deviceLogin.migrateTitle" }, { name }) : formatMessage({ id: "pages.deviceLogin.migrateTitleUnnamed" });
  }
  if (grant.kind === "computer_attach") {
    return name ? formatMessage({ id: "pages.deviceLogin.attachTitle" }, { name }) : formatMessage({ id: "pages.deviceLogin.attachTitleUnnamed" });
  }
  return name ? formatMessage({ id: "pages.deviceLogin.agentKeyTitle" }, { name }) : formatMessage({ id: "pages.deviceLogin.agentKeyTitleUnnamed" });
}

/** The approve button's words, and its in-flight words. */
export function deviceLoginApproveLabel(formatMessage: IntlShape["formatMessage"], grant: DeviceLoginGrant | undefined, approving: boolean): string {
  if (!grant) return formatMessage({ id: approving ? "pages.deviceLogin.approving" : "pages.deviceLogin.approve" });
  if (grant.kind === "computer_migrate") return formatMessage({ id: approving ? "pages.deviceLogin.movingToServer" : "pages.deviceLogin.moveToServer" });
  if (grant.kind === "computer_attach") return formatMessage({ id: approving ? "pages.deviceLogin.addingToServer" : "pages.deviceLogin.addToServer" });
  return formatMessage({ id: approving ? "pages.deviceLogin.givingKey" : "pages.deviceLogin.giveKey" });
}
