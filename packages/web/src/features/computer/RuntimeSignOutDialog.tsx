import { getRuntimeDisplayName, runtimeAuthRuntimeFor } from "@botiverse/raft-shared";
import type { RuntimeAuthLogoutResult, RuntimeAuthRuntime, RuntimeAuthSignedInProvider } from "@botiverse/raft-shared";
import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type { MessageId } from "../../i18n/messages/en";
import { useAgentStore } from "../../store/agentStore";
import { runtimeAuthRequestError } from "../../utils/runtimeAuthClient";
import type { RuntimeAuthClient } from "../../utils/runtimeAuthClient";
import ConfirmDialog from "../../components/ConfirmDialog";
import { useComputerName } from "./useComputerName";

/**
 * Still signed in after the logout ran: Claude Code's account comes from an API
 * key in the environment; Antigravity's from another sign-in on the Computer
 * (GEMINI_API_KEY, or one agy keeps in the system keyring); Grok's from another
 * xAI sign-in, such as an API key in the environment (which variable Grok Build
 * reads, XAI_API_KEY, is assumed, not verified). Signing out again
 * would not help: it has to be removed on that Computer.
 */
const STILL_LOGGED_IN_MESSAGE: Partial<Record<RuntimeAuthRuntime, MessageId>> = {
  antigravity: "machine.runtimeAuth.signOut.stillLoggedInAntigravity",
  grok: "machine.runtimeAuth.signOut.stillLoggedInGrok",
};

function logoutFailureMessageId(runtime: RuntimeAuthRuntime, result: Exclude<RuntimeAuthLogoutResult, { kind: "logged_out" }>): MessageId {
  if (result.kind === "unsupported") {
    if (result.reason === "version_unsupported") return "machine.runtimeAuth.error.versionUnsupported";
    if (result.reason === "not_installed") return "machine.runtimeAuth.error.notInstalled";
    return "machine.runtimeAuth.error.unsupportedInstallation";
  }
  switch (result.reason) {
    case "still_logged_in": return STILL_LOGGED_IN_MESSAGE[runtime] ?? "machine.runtimeAuth.signOut.stillLoggedIn";
    case "timed_out": return "machine.runtimeAuth.signOut.timedOut";
    // OpenCode: a sign-in on that Computer holds its one OpenCode server until it ends.
    case "busy": return "machine.runtimeAuth.opencode.error.signInInProgress";
    case "rejected":
    case "process_failed": return "machine.runtimeAuth.signOut.failed";
  }
}

function logoutRequestMessageId(error: unknown): MessageId {
  const { status, code } = runtimeAuthRequestError(error);
  if (code === "computer_offline") return "machine.runtimeAuth.error.computerOffline";
  if (code === "computer_upgrade_required") return "machine.runtimeAuth.upgradeRequired";
  if (code === "computer_not_attached") return "machine.runtimeAuth.notAttached";
  if (code === "computer_timeout" || status === 504) return "machine.runtimeAuth.signOut.timedOut";
  if (status === 403) return "machine.runtimeAuth.error.forbidden";
  return "machine.runtimeAuth.signOut.failed";
}

export function RuntimeSignOutDialog({
  serverId,
  machineId,
  runtimeId,
  runtime,
  client,
  onClose,
  provider,
}: {
  serverId: string;
  machineId: string;
  /** The Raft runtime the person picked (Kimi Code), for its name. */
  runtimeId: string;
  /** The runtime whose sign-in it uses (OAR's `kimi`). */
  runtime: RuntimeAuthRuntime;
  client: RuntimeAuthClient;
  onClose: () => void;
  /**
   * The one provider to sign out, for a runtime that signs in per provider
   * (Pi): an account is signed out, a key removed; that provider's sign-in
   * only, the runtime's others stay.
   */
  provider?: RuntimeAuthSignedInProvider;
}) {
  const { formatMessage } = useIntl();
  const piRuntimeName = getRuntimeDisplayName(runtimeId);
  const runtimeName = provider?.label ?? piRuntimeName;
  const removesKey = provider?.method === "api_key";
  const computer = useComputerName(machineId) ?? formatMessage({ id: "machine.runtimeAuth.thisComputer" });
  const allAgents = useAgentStore((s) => s.agents);
  // Every agent on a runtime that uses this sign-in (for Kimi: Kimi Code's, not Kimi CLI's).
  const agents = useMemo(
    () => allAgents.filter((agent) => !agent.deletedAt && agent.machineId === machineId && runtimeAuthRuntimeFor(agent.runtime) === runtime),
    [allAgents, machineId, runtime],
  );

  const handleConfirm = useCallback(async () => {
    let result: RuntimeAuthLogoutResult;
    try {
      result = await client.logout(serverId, machineId, runtime, provider?.id);
    } catch (error) {
      throw new Error(formatMessage({ id: logoutRequestMessageId(error) }, { runtime: runtimeName, computer }));
    } finally {
      client.invalidate(serverId, machineId);
    }
    if (result.kind !== "logged_out") {
      throw new Error(formatMessage({ id: logoutFailureMessageId(runtime, result) }, { runtime: runtimeName, computer }));
    }
  }, [client, computer, formatMessage, machineId, provider?.id, runtime, runtimeName, serverId]);

  return (
    <ConfirmDialog
      title={formatMessage({ id: removesKey ? "machine.runtimeAuth.pi.removeKey.title" : "machine.runtimeAuth.signOut.title" }, { runtime: runtimeName })}
      plainMessage
      message={(
        <div className="grid gap-3 text-subhead text-foreground-muted" data-testid={`runtime-sign-out-dialog-${runtime}`}>
          <p>
            {formatMessage(
              { id: provider ? (removesKey ? "machine.runtimeAuth.pi.removeKey.description" : "machine.runtimeAuth.pi.signOut.description") : "machine.runtimeAuth.signOut.description" },
              { runtime: runtimeName, piRuntime: piRuntimeName, computer },
            )}
          </p>
          {agents.length > 0 ? (
            <div className="grid gap-1.5">
              <p>
                {provider
                  ? formatMessage({ id: "machine.runtimeAuth.pi.signOut.agents" }, { runtime: runtimeName, piRuntime: piRuntimeName, count: agents.length })
                  : formatMessage({ id: "machine.runtimeAuth.signOut.agents" }, { runtime: runtimeName, count: agents.length })}
              </p>
              <ul className="grid gap-1 text-callout text-foreground" data-testid="runtime-sign-out-agents">
                {agents.map((agent) => (
                  <li key={agent.id} className="truncate font-semibold">{agent.displayName || agent.name}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p>{formatMessage({ id: "machine.runtimeAuth.signOut.noAgents" }, { runtime: piRuntimeName })}</p>
          )}
        </div>
      )}
      confirmLabel={formatMessage({ id: removesKey ? "machine.runtimeAuth.pi.removeKey.confirm" : "machine.runtimeAuth.signOut.confirm" })}
      confirmVariant="warning"
      layer={1}
      maxWidthClass="max-w-md"
      onConfirm={handleConfirm}
      onClose={onClose}
    />
  );
}
