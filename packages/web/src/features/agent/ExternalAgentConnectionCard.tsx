// An external agent's "External setup" on its page (#wg-external-agent-ux:#2, step 3; Jasper's boards
// Q4USMpwHcDr4itnerZQb2X, states per raft-design status.md, Jasper e7fe29d7). One status line in four
// states: not signed in yet (orange: someone must act), Online, Offline, disconnected (orange). Until it
// has signed in, or once disconnected, the steps the create dialog showed are open below it, with the
// link that switches how it connects; once connected they fold behind "How it connects". Credentials
// sit beside it for whoever may make them: one agent credential serves the CLI login and the SDK.
import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { Button, TextLink, TextLinkExternalIcon } from "@botiverse/raft-ui";
import api from "../../api/client";
import ConfirmDialog from "../../components/ConfirmDialog";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import StatusDot from "../../components/ui/StatusDot";
import Tooltip from "../../components/ui/Tooltip";
import { opensInNewTabAriaLabel } from "../../components/ui/LeavingRaftMark";
import { useAgentDisplayState, useAgentStore } from "../../store/agentStore";
import type { Agent, ExternalAgentStatus } from "../../store/agentStore";
import { formatRelativeTime } from "../../utils/relativeTime";
import { ExternalAgentCredentialList } from "./ExternalAgentCredentialList";
import { CopyBlock, CopyField } from "./ExternalSetupCopy";
import { existingAgentPrompt, externalConnectionState, RAFT_SDK_DOCS_URL, SDK_INSTALL_COMMAND, sdkStarterCode, STATUS_POLL_MS } from "./externalAgentSetup";
import type { ExternalSetupMethod } from "./externalAgentSetup";
import { useExternalAgentCredentials } from "./useExternalAgentCredentials";

type Confirm = { kind: "replace" | "revoke"; credentialId: string } | null;

function StatusLine({ agent, status, expanded, onToggle }: {
  agent: Agent;
  status: ExternalAgentStatus;
  expanded: boolean;
  onToggle: () => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const display = useAgentDisplayState(agent.id, agent);
  const state = externalConnectionState(status.setupState, display.isOnline);
  const name = agent.displayName || agent.name;
  const lastActive = formatRelativeTime(status.lastActivityAt ?? status.credentialLastUsedAt, intl.locale);
  // As the Computers page says it (ComputerRackRow: formatRelativeTime), the exact time in the tooltip.
  const lastSeenAt = display.lastSeenAt ?? status.lastActivityAt ?? status.credentialLastUsedAt;
  const lastSeen = formatRelativeTime(lastSeenAt, intl.locale);
  let titleTooltip: string | null = null;
  let title: string;
  let hint: string;
  if (state === "online") {
    title = formatMessage({ id: "agent.externalCard.online" });
    hint = lastActive ? formatMessage({ id: "agent.externalCard.onlineActive" }, { time: lastActive }) : formatMessage({ id: "agent.externalCard.onlineHint" });
  } else if (state === "offline") {
    title = lastSeen ? formatMessage({ id: "agent.externalCard.offlineLastSeen" }, { time: lastSeen }) : formatMessage({ id: "agent.externalCard.offline" });
    titleTooltip = lastSeenAt ? intl.formatDate(lastSeenAt, { dateStyle: "medium", timeStyle: "short" }) : null;
    hint = formatMessage({ id: "agent.externalCard.offlineHint" });
  } else if (state === "disconnected") {
    title = formatMessage({ id: "agent.externalCard.disconnected" }, { name });
    hint = formatMessage({ id: "agent.externalCard.disconnectedHint" }, { name });
  } else {
    title = formatMessage({ id: "agent.createExternal.waiting" }, { name });
    hint = status.setupState === "credential_minted"
      ? formatMessage({ id: "agent.createExternal.waitingHint" }, { name })
      : formatMessage({ id: "agent.externalCard.noCredentialHint" }, { name });
  }
  const connected = state === "online" || state === "offline";
  return (
    <div className="flex items-start gap-3 rounded-control border border-line px-4 py-3" data-testid="external-agent-status" data-state={state}>
      {/* Not signed in and disconnected need someone to act: orange (status.md "needs attention"). */}
      <StatusDot presence={state === "online" ? "online" : state === "offline" ? "offline" : "error"} className="mt-1.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {titleTooltip ? (
          <Tooltip content={titleTooltip}>
            <p className="text-body font-semibold text-foreground" data-testid="external-agent-status-title">{title}</p>
          </Tooltip>
        ) : (
          <p className="text-body font-semibold text-foreground" data-testid="external-agent-status-title">{title}</p>
        )}
        <p className="text-callout text-foreground-muted">{hint}</p>
      </div>
      {connected ? (
        <Button size="md" variant="ghost" type="button" className="shrink-0" onClick={onToggle} aria-expanded={expanded} data-testid="external-agent-how-it-connects">
          {formatMessage({ id: "agent.externalCard.howItConnects" })}
          {expanded ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </Button>
      ) : null}
    </div>
  );
}

export function ExternalAgentConnectionCard({ agent, status, canIssueCredentials, onStatus }: {
  agent: Agent;
  status: ExternalAgentStatus;
  /** Its creator, or anyone the server lets issue agent credentials: sees Credentials and may make or revoke one. */
  canIssueCredentials: boolean;
  onStatus: (status: ExternalAgentStatus) => void;
}) {
  const { formatMessage } = useIntl();
  const fetchExternalAgentStatus = useAgentStore((s) => s.fetchExternalAgentStatus);
  const display = useAgentDisplayState(agent.id, agent);
  const credentials = useExternalAgentCredentials(agent.id, canIssueCredentials);
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const method: ExternalSetupMethod = status.externalSetupMethod === "sdk" ? "sdk" : "existing_agent";
  const state = externalConnectionState(status.setupState, display.isOnline);
  const connected = state === "online" || state === "offline";
  const name = agent.displayName || agent.name;

  // Until it signs in, the line updates by itself (the create dialog's promise, kept here).
  useEffect(() => {
    if (connected) return undefined;
    let active = true;
    const timer = setInterval(() => {
      void fetchExternalAgentStatus(agent.id).then((next) => { if (active) onStatus(next); }).catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => { active = false; clearInterval(timer); };
  }, [agent.id, connected, fetchExternalAgentStatus, onStatus]);

  const handleToggle = useCallback(() => setExpanded((value) => !value), []);
  const handleSwitch = useCallback(() => {
    const next: ExternalSetupMethod = method === "sdk" ? "existing_agent" : "sdk";
    // The same credential works both ways: only the instructions and the remembered method change.
    onStatus({ ...status, externalSetupMethod: next });
    void api.put(`/agents/${encodeURIComponent(agent.id)}/external-setup-method`, { method: next }).catch(() => onStatus(status));
  }, [agent.id, method, onStatus, status]);

  const pageCredentialId = credentials.pageCredential?.id ?? null;
  const handleCreate = useCallback(() => {
    // Which credential a new one replaces is known only once the list is in.
    if (credentials.loading) return;
    // A new page credential replaces the page's earlier one, so it asks first; a first one doesn't.
    if (pageCredentialId) setConfirm({ kind: "replace", credentialId: pageCredentialId });
    else void credentials.create(null).then((made) => {
      if (made) void fetchExternalAgentStatus(agent.id).then(onStatus).catch(() => undefined);
    });
  }, [agent.id, credentials, fetchExternalAgentStatus, onStatus, pageCredentialId]);
  const handleReplace = useCallback((credentialId: string) => setConfirm({ kind: "replace", credentialId }), []);
  const handleRevoke = useCallback((credentialId: string) => setConfirm({ kind: "revoke", credentialId }), []);
  const handleCloseConfirm = useCallback(() => setConfirm(null), []);
  const handleConfirm = useCallback(async () => {
    if (!confirm) return;
    if (confirm.kind === "replace") await credentials.create(confirm.credentialId);
    else await credentials.revoke(confirm.credentialId);
    void fetchExternalAgentStatus(agent.id).then(onStatus).catch(() => undefined);
  }, [agent.id, confirm, credentials, fetchExternalAgentStatus, onStatus]);

  const showSteps = !connected || expanded;
  const createLabel = formatMessage({ id: pageCredentialId ? "agent.externalCard.createNewCredential" : "agent.externalCard.createCredential" });
  // Someone who manages the agent but can't issue credentials is told who can (status.md: name the step
  // and who can take it): its creator when a person made it, else the server's owners and admins.
  const creatorName = agent.creator?.type === "human" ? agent.creator.displayName || agent.creator.name : null;
  const askForCredential = !canIssueCredentials && !connected ? (
    <p className="text-callout text-foreground-muted" data-testid="external-agent-ask-credential">
      {creatorName
        ? formatMessage({ id: "agent.externalCard.askCreator" }, { name: creatorName })
        : formatMessage({ id: "agent.externalCard.askAdmin" })}
    </p>
  ) : null;
  const credentialStep = askForCredential ?? (canIssueCredentials && !connected ? (
    <div className="stack-y-2" data-testid="external-agent-credential-step">
      {credentials.secret ? (
        <>
          <p className="text-callout text-foreground-muted">{formatMessage({ id: "agent.createExternal.credentialWarning" }, { name })}</p>
          <CopyField text={credentials.secret} testId="external-agent-new-credential" />
          <p className="text-footnote text-foreground-muted">{formatMessage({ id: method === "sdk" ? "agent.createExternal.envHint" : "agent.createExternal.shownOnce" })}</p>
        </>
      ) : (
        <>
          <div>
            <Button size="md" variant="outline" type="button" loading={credentials.busy} disabled={credentials.loading} onClick={handleCreate} data-testid="external-agent-create-credential">
              <Plus aria-hidden="true" />
              {createLabel}
            </Button>
          </div>
          {pageCredentialId ? <p className="text-footnote text-foreground-muted">{formatMessage({ id: "agent.externalCard.shownBefore" }, { name })}</p> : null}
        </>
      )}
      {credentials.error === "create" ? <p role="alert" className="text-footnote font-semibold text-warning-strong">{formatMessage({ id: "agent.externalCard.createError" })}</p> : null}
    </div>
  ) : null);

  return (
    <div className="stack-y-4" data-testid="external-agent-connection">
      <section className="stack-y-3">
        <SectionEyebrow as="div">{formatMessage({ id: "agent.detail.externalSetup" })}</SectionEyebrow>
        <StatusLine agent={agent} status={status} expanded={expanded} onToggle={handleToggle} />
        {showSteps ? (
          <div className="stack-y-4" data-testid="external-agent-steps" data-method={method}>
            {/* Switching how it connects is offered only while it isn't connected (Jasper's boards, v4). */}
            {connected ? null : (
              <TextLink className="self-start text-callout" render={<button type="button" onClick={handleSwitch} />} data-testid="external-agent-switch">
                {formatMessage({ id: method === "sdk" ? "agent.createExternal.switchToExisting" : "agent.createExternal.switchToSdk" })}
              </TextLink>
            )}
            {method === "existing_agent" ? (
              <>
                <section className="stack-y-2">
                  <h3 className="text-body font-semibold">{formatMessage({ id: credentialStep ? "agent.createExternal.step1Existing" : "agent.externalCard.promptStep" })}</h3>
                  <CopyBlock text={existingAgentPrompt(agent, formatMessage)} label={formatMessage({ id: "agent.createExternal.copyPrompt" })} testId="external-agent-prompt" primary collapsed />
                </section>
                {credentialStep ? (
                  <section className="stack-y-2">
                    <h3 className="text-body font-semibold">{formatMessage({ id: "agent.createExternal.step2Existing" })}</h3>
                    {credentialStep}
                  </section>
                ) : null}
              </>
            ) : (
              <>
                {credentialStep ? (
                  <section className="stack-y-2">
                    <h3 className="text-body font-semibold">{formatMessage({ id: "agent.createExternal.step1Sdk" })}</h3>
                    {credentialStep}
                  </section>
                ) : null}
                <section className="stack-y-2">
                  <h3 className="text-body font-semibold">{formatMessage({ id: credentialStep ? "agent.createExternal.step2Sdk" : "agent.externalCard.sdkStep" })}</h3>
                  <CopyField text={SDK_INSTALL_COMMAND} testId="external-agent-install" />
                  <CopyField text={sdkStarterCode()} testId="external-agent-code" />
                  <p className="text-callout text-foreground-muted">
                    {formatMessage({ id: "agent.createExternal.sdkConnectsHint" }, { name })}
                    <TextLink variant="strong" className="ml-1" render={<a href={RAFT_SDK_DOCS_URL} target="_blank" rel="noopener noreferrer" aria-label={opensInNewTabAriaLabel(formatMessage, formatMessage({ id: "agent.createExternal.sdkGuide" }))} />}>
                      {formatMessage({ id: "agent.createExternal.sdkGuide" })}
                      <TextLinkExternalIcon />
                    </TextLink>
                  </p>
                </section>
              </>
            )}
          </div>
        ) : null}
      </section>
      {canIssueCredentials ? (
        <>
          <ExternalAgentCredentialList
            credentials={credentials.active}
            loading={credentials.loading}
            listError={credentials.listError}
            disabled={credentials.busy}
            onReplace={handleReplace}
            onRevoke={handleRevoke}
          />
          {credentials.error === "revoke" ? <p role="alert" className="text-footnote font-semibold text-warning-strong">{formatMessage({ id: "agent.externalCard.revokeError" })}</p> : null}
          {credentials.error === "create" && connected ? <p role="alert" className="text-footnote font-semibold text-warning-strong">{formatMessage({ id: "agent.externalCard.createError" })}</p> : null}
          {credentials.secret && connected ? (
            <div className="stack-y-2" data-testid="external-agent-credential-step">
              <p className="text-callout text-foreground-muted">{formatMessage({ id: "agent.createExternal.credentialWarning" }, { name })}</p>
              <CopyField text={credentials.secret} testId="external-agent-new-credential" />
            </div>
          ) : null}
        </>
      ) : null}
      {confirm?.kind === "replace" ? (
        <ConfirmDialog
          title={formatMessage({ id: "agent.externalCard.replaceTitle" })}
          message={formatMessage({ id: "agent.externalCard.replaceMessage" }, { name })}
          confirmLabel={formatMessage({ id: "agent.externalCard.createNewCredential" })}
          confirmVariant="warning"
          confirmTestId="external-agent-replace-confirm"
          onConfirm={handleConfirm}
          onClose={handleCloseConfirm}
        />
      ) : null}
      {confirm?.kind === "revoke" ? (
        <ConfirmDialog
          title={formatMessage({ id: "agent.externalCard.revokeTitle" })}
          message={formatMessage({ id: "agent.externalCard.revokeMessage" }, { name })}
          confirmLabel={formatMessage({ id: "agent.externalCard.revoke" })}
          confirmVariant="danger"
          confirmTestId="external-agent-revoke-confirm"
          onConfirm={handleConfirm}
          onClose={handleCloseConfirm}
        />
      ) : null}
    </div>
  );
}
